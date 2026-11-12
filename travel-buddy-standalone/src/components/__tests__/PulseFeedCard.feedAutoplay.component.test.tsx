/**
 * PulseFeedCard — the card the feed picks plays its video in place, muted
 * (2026-11-04: "videos should play on auto").
 *
 * The feed (app/(tabs)/index.tsx) picks at most one card at a time with
 * lib/media/feedAutoplay.ts and passes it autoplayVideo. That card keeps its
 * poster underneath and mounts FeedAutoplayVideo on top; every other card,
 * and every card that is not a video, plays nothing.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

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
// NOTE: intentionally exhaustive — imports Supabase storage helpers.
jest.mock('../CachedImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CachedImage: () => React.createElement(View, { testID: 'cached-image-mock' }),
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

// ── FeedAutoplayVideo ─────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the stub records the source it was handed;
// FeedAutoplayVideo's own behaviour is media/__tests__/FeedAutoplayVideo.component.test.tsx.
jest.mock('../media/FeedAutoplayVideo.tsx', () => ({
  FeedAutoplayVideo: require('react').forwardRef(({ uri, ...props }: { uri: string }, ref: any) => {
    const React = require('react');
    const { View } = require('react-native');
    React.useImperativeHandle(ref, () => ({ pause: async () => {} }));
    return React.createElement(View, { testID: 'feed-autoplay-video', uri, ...props });
  }),
}));
// NOTE: this card owns the in-place handoff. The takeover integration mounts real comments and transport.
jest.mock('../PostTakeover.tsx', () => ({ PostTakeover: (props: any) => require('react').createElement(require('react-native').View, { testID: 'post-takeover', ...props }) }));

// ── Component under test ───────────────────────────────────────────────────────
import { PulseFeedCard } from '../PulseFeedCard.tsx';
import type { PulseFeedItem } from '../../types/models.ts';

function makePostItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'post-1',
    type: 'post',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: { id: 'author-1', name: 'Alice', username: 'alice', avatarUrl: null, verified: false, isOfficial: false },
    caption: 'Sunrise over the bay.',
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

const VIDEO_MEDIA = [{ url: 'post-media/u-1/2.mov', thumbnail_url: 'post-media/u-1/2-thumb.jpg', media_type: 'video' }];

describe('PulseFeedCard — the picked card plays its video', () => {
  it('opens a video over the feed, retires inline playback, and resumes it at the returned position', async () => {
    jest.mocked(router.push).mockClear();
    await render(<PulseFeedCard item={makePostItem({ media: VIDEO_MEDIA as any })} autoplayVideo />);
    await act(async () => screen.getByTestId('feed-autoplay-video').props.onPositionChange(12000));
    await fireEvent.press(screen.getByLabelText('View video full screen'), { stopPropagation: jest.fn() });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
    expect(screen.getByTestId('post-takeover').props).toMatchObject({ postId: 'post-1', initialMediaUri: VIDEO_MEDIA[0].url, initialPositionMillis: 12000 });
    await act(async () => { screen.getByTestId('post-takeover').props.onPositionChange(18000); screen.getByTestId('post-takeover').props.onClose(); });
    expect(screen.queryByTestId('post-takeover')).toBeNull();
    expect(screen.getByTestId('feed-autoplay-video').props.initialPositionMillis).toBe(18000);
  });

  it('opens original photos over the same feed without routing to another page', async () => {
    jest.mocked(router.push).mockClear();
    await render(<PulseFeedCard item={makePostItem({ mediaUrl: 'post-media/u-1/original.jpg' })} />);
    await fireEvent.press(screen.getByLabelText('View photo full screen'), { stopPropagation: jest.fn() });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('post-takeover').props).toMatchObject({ postId: 'post-1', initialMediaUri: 'post-media/u-1/original.jpg' });
  });

  it('a video post the feed picked plays its own video over the poster', async () => {
    await render(<PulseFeedCard item={makePostItem({ media: VIDEO_MEDIA as any })} autoplayVideo />);
    expect((screen.getByTestId('feed-autoplay-video') as any).props.uri).toBe('post-media/u-1/2.mov');
    expect(screen.getByTestId('video-thumbnail')).toBeTruthy();
  });

  it('a camera video with no media row plays its video file', async () => {
    await render(<PulseFeedCard item={makePostItem({ media: undefined, mediaUrl: 'post-media/u-1/1792727980484.mov' })} autoplayVideo />);
    expect((screen.getByTestId('feed-autoplay-video') as any).props.uri).toBe('post-media/u-1/1792727980484.mov');
  });

  it('a video post the feed did NOT pick shows only its poster', async () => {
    await render(<PulseFeedCard item={makePostItem({ media: VIDEO_MEDIA as any })} />);
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
    expect(screen.getByTestId('video-thumbnail')).toBeTruthy();
  });

  it('a photo post plays nothing even if picked', async () => {
    await render(<PulseFeedCard item={makePostItem({ media: undefined, mediaUrl: 'post-media/u-1/1792727701590.jpg' })} autoplayVideo />);
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
  });
});
