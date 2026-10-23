/**
 * PulseFeedCard — a post whose only media is a video FILE is drawn as a video tile with the video's derived poster.
 *
 * The owner's camera videos (2026-10-23) were published and showed no picture: such a post has no media row, so the
 * card took its .mov as a photo, asked Supabase's image transform for it (400 on production), the <Image> failed and
 * the card fell back to text. It now recognises the video file, shows VideoThumbnail, and hands it the poster the
 * upload stored beside the video (`<video>.poster.jpg`).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// modules that crash the JS-only renderer.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(effect, []);
  },
}));

// ── SessionContext ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — SessionContext imports Supabase auth
// internals that are not safe under the JS-only renderer.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// ── BlockedIdsContext ─────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — BlockedIdsContext pulls Supabase realtime
// subscriptions that crash the JS-only renderer.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set(), isLoading: false }),
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
// NOTE: intentionally exhaustive — pulls native-module internals unsafe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── react-native-reanimated ───────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.useReducedMotion = () => false;
  return Reanimated;
});

// ── PlanPickerController ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — requires navigation context at runtime.
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// ── expo-linear-gradient ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — pulls a native gradient module.
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ── CachedImage ────────────────────────────────────────────────────────────────
// The mock forwards `onError` so tests can trigger an image-load failure.
// NOTE: intentionally exhaustive — imports Supabase storage helpers.
let _cachedImageOnError: (() => void) | undefined;
jest.mock('../CachedImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CachedImage: ({ onError }: { onError?: () => void }) => {
      _cachedImageOnError = onError;
      return React.createElement(View, { testID: 'cached-image-mock' });
    },
    withStorageParams: (uri: string) => uri,
  };
});

// ── batchSignUrls ──────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — makes a real network call in production.
jest.mock('../../lib/batchSignMedia.ts', () => ({
  batchSignUrls: async (urls: string[]) => new Map(urls.map((u: string) => [u, u])),
}));

// ── AvatarImage ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — DisplayMediaImage imports Supabase storage
// helpers that are not safe under jest.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({ AvatarImage: () => null }));

// ── useHighlightRingState ──────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — hits highlight services.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

// ── displayIdentity ────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports locale-dependent formatting utilities.
jest.mock('../../lib/displayIdentity.ts', () => ({
  primaryIdentityText: ({ username }: { username?: string | null }) => username ?? '',
}));

// ── navigateToProfile ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls router APIs that require a mounted
// navigation stack.
jest.mock('../../lib/navigateToProfile.ts', () => ({
  navigateToProfile: jest.fn(),
}));

// ── HighlightRing — needs children pass-through ───────────────────────────────
jest.mock('../HighlightRing.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    HighlightRing: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(View, null, children),
  };
});

// ── Stubs for heavy sub-components ────────────────────────────────────────────
// NOTE: intentionally exhaustive — HighlightViewer requires modal native deps.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));
// NOTE: intentionally exhaustive — ReportSheet requires bottom-sheet native deps.
jest.mock('../ReportSheet.tsx', () => ({ ReportSheet: () => null }));
// NOTE: intentionally exhaustive — SaveButton hits bookmark services.
jest.mock('../SaveButton.tsx', () => ({ SaveButton: () => null }));
// NOTE: intentionally exhaustive — PostEngagementBar fetches engagement data.
jest.mock('../PostEngagementBar.tsx', () => ({ PostEngagementBar: () => null }));
// NOTE: intentionally exhaustive — CompassFeedbackMenu needs compass context.
jest.mock('../compass/CompassFeedbackMenu.tsx', () => ({ CompassFeedbackMenu: () => null }));
// NOTE: intentionally exhaustive — CompassWhySheet needs bottom-sheet native deps.
jest.mock('../compass/CompassWhySheet.tsx', () => ({ CompassWhySheet: () => null }));
// NOTE: intentionally exhaustive — MediaStampOverlay loads stamp assets.
jest.mock('../StampOverlayBadge.tsx', () => ({ MediaStampOverlay: () => null }));
// NOTE: intentionally exhaustive — VideoThumbnail uses native video deps. The stub keeps the poster it was given.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: ({ posterUri }: { posterUri?: string | null }) => {
    const React = require('react');
    const { View } = require('react-native');
    return React.createElement(View, { testID: 'video-thumbnail', posterUri });
  },
}));
// NOTE: intentionally exhaustive — LocationChip uses location context.
jest.mock('../LocationChip.tsx', () => ({ LocationChip: () => null }));
// NOTE: intentionally exhaustive — RichText uses text-parsing utilities.
jest.mock('../RichText.tsx', () => ({
  RichText: ({ content }: { content?: string }) => {
    const React = require('react');
    const { Text } = require('react-native');
    return React.createElement(Text, { testID: 'post-caption' }, content ?? '');
  },
}));
// NOTE: intentionally exhaustive — OfficialBadge imports SVG assets.
jest.mock('../OfficialBadge.tsx', () => ({ OfficialBadge: () => null }));
// NOTE: intentionally exhaustive — VerifiedStamp imports SVG assets.
jest.mock('../ui/VerifiedStamp.tsx', () => ({ VerifiedStamp: () => null }));
// NOTE: intentionally exhaustive — PlaceQuickActions hits place services.
jest.mock('../PlaceQuickActions.tsx', () => ({ PlaceQuickActions: () => null }));
// NOTE: intentionally exhaustive — PostWrongPlaceSheet requires bottom-sheet native deps.
jest.mock('../PostWrongPlaceSheet.tsx', () => ({ PostWrongPlaceSheet: () => null }));
// NOTE: intentionally exhaustive — SharedPostCard pulls in full card render tree.
jest.mock('../cards/PostCard.tsx', () => ({ PostCard: () => null }));
// NOTE: intentionally exhaustive — UserIdentityLink imports navigation context.
jest.mock('../interaction/UserIdentityLink.tsx', () => ({
  UserIdentityLink: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
// NOTE: intentionally exhaustive — FeaturedBadge imports lucide icons that
// require native module setup.
jest.mock('../FeaturedBadge.tsx', () => ({ FeaturedBadge: () => null }));

// ── services ───────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — postEngagement makes real Supabase calls.
jest.mock('../../services/postEngagement.ts', () => ({ deletePost: jest.fn() }));
// NOTE: intentionally exhaustive — posts service makes real Supabase calls.
jest.mock('../../services/posts.ts', () => ({ hidePost: jest.fn() }));

// ── Component under test ───────────────────────────────────────────────────────
import { PulseFeedCard } from '../PulseFeedCard.tsx';
import type { PulseFeedItem } from '../../types/models.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AUTHOR = {
  id: 'author-1',
  name: 'Alice',
  username: 'alice',
  avatarUrl: null,
  verified: false,
  isOfficial: false,
};

function makePostItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'post-1',
    type: 'post',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: AUTHOR,
    caption: 'A lovely sunrise over the bay.',
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}


// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _cachedImageOnError = undefined;
});

describe('PulseFeedCard — a video file post', () => {
  it('a post whose only media is a .mov shows the video tile with the derived poster, not a photo frame', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ media: undefined, mediaUrl: 'post-media/u-1/1792727980484.mov' })} />,
    );
    const tile = screen.getByTestId('video-thumbnail') as any;
    expect(tile.props.posterUri).toBe('post-media/u-1/1792727980484.mov.poster.jpg');
    expect(screen.queryByTestId('cached-image-mock')).toBeNull();
    // The card kept its media frame — it did not collapse to the text layout.
    expect(screen.getByTestId('top-left-stack')).toBeTruthy();
  });

  it('a media row that says video keeps using its own thumbnail', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ media: [{ url: 'post-media/u-1/2.mov', thumbnail_url: 'post-media/u-1/2-thumb.jpg', media_type: 'video' }] as any })} />,
    );
    expect((screen.getByTestId('video-thumbnail') as any).props.posterUri).toBe('post-media/u-1/2-thumb.jpg');
  });

  it('a photo post is unchanged: the photo frame, no video tile', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ media: undefined, mediaUrl: 'post-media/u-1/1792727701590.jpg' })} />,
    );
    expect(screen.getByTestId('cached-image-mock')).toBeTruthy();
    expect(screen.queryByTestId('video-thumbnail')).toBeNull();
  });
});
