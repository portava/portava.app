/**
 * MediaViewer — stamp count creator analytics tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Owner viewing their own post with stampItCount > 0 → gold Zap badge shown.
 * 2. Non-owner viewing the same post → stamp badge NOT shown.
 * 3. Owner viewing their own post with stampItCount === 0 → badge hidden.
 *
 * ## Why these tests exist
 *
 * The stamp count badge is a creator-only analytics signal. If the isOwner
 * gate or stampItCount guard regresses, creators either lose the signal or
 * non-owners see an unintended analytics metric.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// ── Infrastructure mocks ──────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — real module chains into native layout
// engines; only insets shape matters here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional exhaustive stub — expo-router global state is not needed;
// test only requires a stable id param and no-op navigation.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'post-stamp-test' }),
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: intentional exhaustive stub — expo-av native Video module is
// unavailable under jest-expo; test posts are images so Video is never rendered.
jest.mock('expo-av', () => ({
  Video: () => null,
  ResizeMode: { COVER: 'cover' },
}));

// NOTE: intentional exhaustive stub — LinearGradient is a visual-only wrapper;
// its children still render so the overlay content is reachable.
// React.createElement cannot be used directly (jest.mock factories are hoisted
// before imports), so we require React inside the factory.
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: any) =>
    require('react').createElement(require('react').Fragment, null, children),
}));

// NOTE: intentional exhaustive stub — AsyncStorage persistence (mute pref) is
// not under test; always return null so no async state mutation happens.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentional exhaustive stub — viewer context is seeded with the test
// item; real module reads AsyncStorage which is irrelevant here.
jest.mock('../../../src/lib/viewerContext.ts', () => ({
  getViewerContext: () => ({
    items: [{ id: 'post-stamp-test', posterUrl: null, thumbnailUrl: null, mediaType: 'image' }],
    initialIndex: 0,
  }),
  clearViewerContext: jest.fn(),
}));

// NOTE: intentional exhaustive stub — like/save hook state is not under test;
// fixed shapes prevent hook from touching the network.
jest.mock('../../../src/hooks/useMediaLike.ts', () => ({
  useMediaLike: () => ({
    likedSet: {},
    likeCounts: {},
    toggle: jest.fn(),
    seed: jest.fn(),
  }),
}));

// NOTE: intentional exhaustive stub — save hook state is not under test.
jest.mock('../../../src/hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({
    savedSet: {},
    toggle: jest.fn(),
    seed: jest.fn(),
  }),
}));

// NOTE: intentional exhaustive stub — share recording is a fire-and-forget
// side effect; not relevant to stamp count visibility.
jest.mock('../../../src/services/mediaInteractions.ts', () => ({
  recordMediaShare: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentional exhaustive stub — comment sheet is a separate component
// not under test; it must not mount to avoid its own deep mock chain.
jest.mock('../../../src/components/media/MediaCommentSheet.tsx', () => ({
  MediaCommentSheet: () => null,
}));

// NOTE: intentional exhaustive stub — location stamp is a visual badge
// whose presence/absence is not asserted in these tests.
jest.mock('../../../src/components/media/VerifiedLocationStamp.tsx', () => ({
  VerifiedLocationStamp: () => null,
}));

// NOTE: intentional exhaustive stub — place quick actions require a geo
// context not needed for stamp count assertions.
jest.mock('../../../src/components/PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

// NOTE: intentional exhaustive stub — fetchMediaFeedItemById is controlled
// per-test; other exports (fetchWatchFeed etc.) are not called by MediaViewer.
jest.mock('../../../src/services/mediaFeed.ts', () => ({
  fetchMediaFeedItemById: jest.fn(),
}));

// NOTE: intentional exhaustive stub — useSession is controlled per-test to
// simulate owner vs. non-owner; no other context fields are read by this screen.
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  useSession: jest.fn(),
}));

import MediaViewer from '../[id].tsx';
import { fetchMediaFeedItemById } from '../../../src/services/mediaFeed.ts';
import { useSession } from '../../../src/context/SessionContext.tsx';

const mockFetch   = fetchMediaFeedItemById as jest.Mock;
const mockSession = useSession as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUTHOR_ID = 'user-author-123';
const OTHER_ID  = 'user-other-456';

function makeItem(stampItCount: number) {
  return {
    id: 'post-stamp-test',
    videoUrl: '',
    posterUrl: null,
    duration: null,
    creator: {
      id: AUTHOR_ID,
      displayName: 'Test Author',
      username: 'testauthor',
      avatarUrl: null,
      isFollowing: false,
    },
    caption: 'test caption',
    hashtags: [],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 5,
    commentCount: 2,
    saveCount: 1,
    likedByMe: false,
    savedByMe: false,
    stampItCount,
    locationVerified: false,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MediaViewer stamp count badge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the stamp badge when the viewer is the post owner and stampItCount > 0', async () => {
    mockSession.mockReturnValue({ userId: AUTHOR_ID, isAuthed: true });
    mockFetch.mockResolvedValue({ ok: true, data: makeItem(7) });

    await render(<MediaViewer />);

    await waitFor(() => {
      expect(screen.getByLabelText('7 stamps')).toBeTruthy();
    });
  });

  it('hides the stamp badge when the viewer is NOT the post owner', async () => {
    mockSession.mockReturnValue({ userId: OTHER_ID, isAuthed: true });
    mockFetch.mockResolvedValue({ ok: true, data: makeItem(7) });

    await render(<MediaViewer />);

    await waitFor(() => {
      expect(screen.queryByLabelText('7 stamps')).toBeNull();
    });
  });

  it('hides the stamp badge when the owner has 0 stamps', async () => {
    mockSession.mockReturnValue({ userId: AUTHOR_ID, isAuthed: true });
    mockFetch.mockResolvedValue({ ok: true, data: makeItem(0) });

    await render(<MediaViewer />);

    await waitFor(() => {
      expect(screen.queryByLabelText('0 stamps')).toBeNull();
    });
  });
});
