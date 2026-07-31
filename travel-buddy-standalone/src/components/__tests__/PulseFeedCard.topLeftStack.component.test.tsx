/**
 * PulseFeedCard — topLeftStack container presence and badge-stacking order
 *
 * Confirms that:
 *   1. The `topLeftStack` flex-column container is present in the media frame.
 *   2. When `featuredByPortava` is set, FeaturedBadge renders inside that
 *      container ABOVE (before) the postcard-label child — stacked, not
 *      overlapping.
 *   3. When `featuredByPortava` is absent, only the postcard label renders
 *      inside the container (badge absent).
 *   4. The city text appears uppercased in all relevant states.
 *
 * Render-order assertion: the JSON tree of the topLeftStack node is inspected
 * directly to verify that the featured-badge child precedes the postcard-label
 * child, matching the visual "badge above label" requirement.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

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

// ── FeaturedBadge — testID stub so presence and order can be asserted ─────────
// NOTE: intentionally exhaustive — the real FeaturedBadge imports lucide icons
// that require native module setup; a labelled stub is safe and sufficient.
jest.mock('../FeaturedBadge.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FeaturedBadge: ({ category }: { category?: string | null }) =>
      React.createElement(View, {
        testID: 'featured-badge',
        accessibilityLabel: `Featured: ${category ?? 'generic'}`,
      }),
  };
});

// ── Component under test ───────────────────────────────────────────────────────
import { PulseFeedCard } from '../PulseFeedCard.tsx';
import type { PulseFeedItem } from '../../types/models.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Finds the index of a child (by testID) within a rendered RNTL node's
 * children array. Returns -1 when not found (child was not rendered).
 *
 * Because FlatList and nested Views can wrap nodes, we walk only the
 * *direct* children of the given parent node.
 */
function childIndexByTestId(parent: ReactTestInstance, testID: string): number {
  return parent.children.findIndex(
    (child) => typeof child !== 'string' && child.props?.testID === testID,
  );
}

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
 * Builds a post item with a synthetic media URL so the media-frame branch
 * renders — the topLeftStack and postcardLabel live inside that branch.
 */
function makePostItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'post-1',
    type: 'post',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: AUTHOR,
    media: [{ url: 'https://example.com/photo.jpg', thumbnail_url: 'https://example.com/thumb.jpg' }],
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PulseFeedCard — topLeftStack container presence and badge-stacking order', () => {
  it('topLeftStack container renders in the media frame', async () => {
    await render(<PulseFeedCard item={makePostItem()} />);

    // The container must be present regardless of badge state.
    expect(screen.getByTestId('top-left-stack')).toBeTruthy();
  });

  it('badge renders BEFORE (above) the city label inside topLeftStack when featuredByPortava is set', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ featuredByPortava: 'best_hidden_gem', city: 'Kyoto' })} />,
    );

    const stack = screen.getByTestId('top-left-stack');

    // Both elements must be present inside the stack.
    expect(within(stack).getByTestId('featured-badge')).toBeTruthy();
    expect(within(stack).getByTestId('postcard-label')).toBeTruthy();

    // Badge must appear BEFORE the label in the child order — confirming it
    // is rendered above (not overlapping) the city label.
    const badgeIdx = childIndexByTestId(stack, 'featured-badge');
    const labelIdx = childIndexByTestId(stack, 'postcard-label');
    expect(badgeIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeLessThan(labelIdx);

    // City text is uppercased inside the label.
    expect(within(stack).getByText('KYOTO')).toBeTruthy();
  });

  it('only the city label is inside topLeftStack when featuredByPortava is absent', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ featuredByPortava: null, city: 'Lisbon' })} />,
    );

    const stack = screen.getByTestId('top-left-stack');

    // Badge must be absent — label sits alone at the top of the stack.
    expect(within(stack).queryByTestId('featured-badge')).toBeNull();
    expect(within(stack).getByTestId('postcard-label')).toBeTruthy();
    expect(within(stack).getByText('LISBON')).toBeTruthy();
  });

  it('postcard label shows fallback text when city is absent and badge is present', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ featuredByPortava: 'best_video', city: undefined })} />,
    );

    const stack = screen.getByTestId('top-left-stack');

    // Badge still renders above the fallback label.
    const badgeIdx = childIndexByTestId(stack, 'featured-badge');
    const labelIdx = childIndexByTestId(stack, 'postcard-label');
    expect(badgeIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeLessThan(labelIdx);

    // Fallback label text when no city is available.
    expect(within(stack).getByText('POSTCARD')).toBeTruthy();
  });

  it('postcard label shows fallback text when neither city nor badge is set', async () => {
    await render(
      <PulseFeedCard item={makePostItem({ featuredByPortava: null, city: undefined })} />,
    );

    const stack = screen.getByTestId('top-left-stack');

    expect(within(stack).queryByTestId('featured-badge')).toBeNull();
    expect(within(stack).getByTestId('postcard-label')).toBeTruthy();
    expect(within(stack).getByText('POSTCARD')).toBeTruthy();
  });
});
