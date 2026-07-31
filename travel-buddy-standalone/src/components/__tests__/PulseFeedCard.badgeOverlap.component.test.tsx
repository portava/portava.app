/**
 * PulseFeedCard — postcard label vs. featured badge overlap guard
 *
 * Confirms that the FeaturedBadge and postcard label are never visually
 * overlapping: the topLeftStack flex column ensures the badge stacks ABOVE
 * the label whenever both are present.
 *
 * Four combinations are tested:
 *   1. both featuredByPortava and city set       → badge + label
 *   2. featuredByPortava only (no city)          → badge + label (fallback text)
 *   3. city only (no featuredByPortava)          → no badge, label present
 *   4. neither                                   → no badge, label with fallback
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

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
// NOTE: intentionally exhaustive — SessionContext imports Supabase auth internals.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// ── BlockedIdsContext ─────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — BlockedIdsContext pulls Supabase realtime.
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
    CachedImage: () => React.createElement(View, null),
    withStorageParams: (uri: string) => uri,
  };
});

// ── batchSignUrls ──────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — makes a real network call in production.
jest.mock('../../lib/batchSignMedia.ts', () => ({
  batchSignUrls: async (urls: string[]) => new Map(urls.map((u: string) => [u, u])),
}));

// ── AvatarImage ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — DisplayMediaImage imports Supabase storage helpers
// that are not safe under jest.
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
// NOTE: intentionally exhaustive — VideoThumbnail uses native video deps.
jest.mock('../ui/VideoThumbnail.tsx', () => ({ VideoThumbnail: () => null }));
// NOTE: intentionally exhaustive — LocationChip uses location context.
jest.mock('../LocationChip.tsx', () => ({ LocationChip: () => null }));
// NOTE: intentionally exhaustive — RichText uses text-parsing utilities.
jest.mock('../RichText.tsx', () => ({ RichText: () => null }));
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

// ── services ───────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — postEngagement makes real Supabase calls.
jest.mock('../../services/postEngagement.ts', () => ({ deletePost: jest.fn() }));
// NOTE: intentionally exhaustive — posts service makes real Supabase calls.
jest.mock('../../services/posts.ts', () => ({ hidePost: jest.fn() }));

// ── FeaturedBadge — renders a testID so we can assert its presence ────────────
// NOTE: intentionally exhaustive — the real FeaturedBadge imports lucide icons
// that require native module setup; a labelled stub is safe and sufficient.
jest.mock('../FeaturedBadge.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FeaturedBadge: ({ category }: { category?: string | null }) =>
      React.createElement(View, { testID: 'featured-badge', accessibilityLabel: `Featured: ${category ?? 'generic'}` }),
  };
});

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

/**
 * Builds a post-type item with a synthetic media URL so the media frame
 * branch renders (postcardLabel lives inside that branch).
 */
function makePostItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'post-1',
    type: 'post',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: AUTHOR,
    // Provide a thumbnail so showMediaFrame is true and the postcard overlay renders.
    media: [{ url: 'https://example.com/photo.jpg', thumbnail_url: 'https://example.com/thumb.jpg' }],
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PulseFeedCard — postcard label and featured badge overlap guard', () => {
  it('both featuredByPortava and city set: badge renders, postcard label renders', async () => {
    await render(
      <PulseFeedCard
        item={makePostItem({ featuredByPortava: 'best_hidden_gem', city: 'Tokyo' })}
      />,
    );

    // Featured badge must be present when featuredByPortava is set.
    expect(screen.getByTestId('featured-badge')).toBeTruthy();

    // Postcard label must always be present in the media frame.
    const label = screen.getByTestId('postcard-label');
    expect(label).toBeTruthy();

    // The city text must be rendered inside the label.
    expect(screen.getByText('TOKYO')).toBeTruthy();
  });

  it('featuredByPortava set, no city: badge renders, postcard label shows fallback text', async () => {
    await render(
      <PulseFeedCard
        item={makePostItem({ featuredByPortava: 'best_video', city: undefined })}
      />,
    );

    expect(screen.getByTestId('featured-badge')).toBeTruthy();

    // Postcard label present with fallback text.
    expect(screen.getByTestId('postcard-label')).toBeTruthy();
    expect(screen.getByText('POSTCARD')).toBeTruthy();
  });

  it('city set, no featuredByPortava: NO badge, postcard label renders normally', async () => {
    await render(
      <PulseFeedCard
        item={makePostItem({ featuredByPortava: null, city: 'Lisbon' })}
      />,
    );

    // Badge must be absent — postcardLabel sits at the top of the stack alone.
    expect(screen.queryByTestId('featured-badge')).toBeNull();

    // Postcard label is still present without disturbance.
    expect(screen.getByTestId('postcard-label')).toBeTruthy();
    expect(screen.getByText('LISBON')).toBeTruthy();
  });

  it('neither featuredByPortava nor city: NO badge, postcard label shows fallback', async () => {
    await render(
      <PulseFeedCard
        item={makePostItem({ featuredByPortava: null, city: undefined })}
      />,
    );

    expect(screen.queryByTestId('featured-badge')).toBeNull();
    expect(screen.getByTestId('postcard-label')).toBeTruthy();
    expect(screen.getByText('POSTCARD')).toBeTruthy();
  });

  it('date mark and trip label badge positions are not disturbed when both overlays are present', async () => {
    await render(
      <PulseFeedCard
        item={makePostItem({
          featuredByPortava: 'best_photo',
          city: 'Paris',
          tripLabel: 'Weekend Trip',
          timeAgo: '3h ago',
        })}
      />,
    );

    // Featured badge and postcard label both present.
    expect(screen.getByTestId('featured-badge')).toBeTruthy();
    expect(screen.getByTestId('postcard-label')).toBeTruthy();

    // Date mark still appears (timeAgo text).
    expect(screen.getByText('3h ago')).toBeTruthy();

    // Trip label badge still appears.
    expect(screen.getByText('Weekend Trip')).toBeTruthy();
  });
});
