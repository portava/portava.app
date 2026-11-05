/**
 * PostDetailCard — video playback integration test.
 *
 * Renders the REAL SharedVideoPlayer (no stub) through the PostDetailCard
 * mounting path. Opening a video post plays it at once WITH sound
 * (2026-11-04: "videos should play on auto and the videos have no sound"),
 * and pressing the tap zone of the playing video pauses it.
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

// ── Supporting mocks (same as PostDetailCard.component.test.tsx) ──────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Every focus effect the screen registers: blurScreen() runs their cleanups (another
// screen pushed on top), focusScreen() runs them again (back in front).
type MockFocusEntry = { run: () => void | (() => void); cleanup: void | (() => void) };
const mockFocusEffects = new Set<MockFocusEntry>();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'post-abc' }),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require('react');
    const latest = React.useRef(effect);
    latest.current = effect;
    React.useEffect(() => {
      const entry: MockFocusEntry = { run: () => latest.current(), cleanup: undefined };
      entry.cleanup = entry.run();
      mockFocusEffects.add(entry);
      return () => {
        mockFocusEffects.delete(entry);
        if (typeof entry.cleanup === 'function') entry.cleanup();
      };
    }, []);
  },
}));
function blurScreen() {
  for (const entry of mockFocusEffects) {
    if (typeof entry.cleanup === 'function') entry.cleanup();
    entry.cleanup = undefined;
  }
}
function focusScreen() {
  for (const entry of mockFocusEffects) entry.cleanup = entry.run();
}

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
  mockFocusEffects.clear();
});

describe('PostDetailCard video playback', () => {
  it('opening a video post plays it at once, with sound', async () => {
    mockGetPostById.mockResolvedValue({ ok: true as const, data: makeVideoPost() });

    await render(<PostDetail />);

    // Wait for the post to load and the real SharedVideoPlayer to mount
    await waitFor(() => expect(screen.getByTestId('mock-video')).toBeTruthy());
    const video = screen.getByTestId('mock-video') as any;
    expect(video.props.shouldPlay).toBe(true);
    expect(video.props.isMuted).toBe(false);
    expect(screen.getByLabelText('Mute')).toBeTruthy();
  });

  it('calls pauseAsync when the tap zone of the playing video is pressed', async () => {
    mockGetPostById.mockResolvedValue({ ok: true as const, data: makeVideoPost() });

    await render(<PostDetail />);

    await waitFor(() =>
      expect(screen.getByLabelText('Pause video')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Pause video'));
    });

    expect(mockPauseAsync).toHaveBeenCalledTimes(1);
    expect(mockPlayAsync).not.toHaveBeenCalled();
  });

  it('stops while another screen is on top and plays again on return (no sound under the next screen)', async () => {
    mockGetPostById.mockResolvedValue({ ok: true as const, data: makeVideoPost() });

    await render(<PostDetail />);
    await waitFor(() => expect((screen.getByTestId('mock-video') as any).props.shouldPlay).toBe(true));

    await act(async () => { blurScreen(); });
    expect((screen.getByTestId('mock-video') as any).props.shouldPlay).toBe(false);

    await act(async () => { focusScreen(); });
    await waitFor(() => expect((screen.getByTestId('mock-video') as any).props.shouldPlay).toBe(true));
  });
});
