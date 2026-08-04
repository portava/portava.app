/**
 * PulseFeedCard — compact count formatting for PlanCard and QuestionCard
 *
 * Confirms that:
 *   1. A `type='plan'` item with attendeeCount > 999 shows the compact form
 *      (e.g. "1.2K going"), not the raw number.
 *   2. A `type='question'` item with replyCount > 999 shows the compact form
 *      (e.g. "1.2K answers"), not the raw number.
 *
 * The compact text lives inside the `actionsSlot` prop that both card variants
 * pass to SharedPostCard.  SharedPostCard is mocked to render its `actionsSlot`
 * children directly, which lets the assertions land on the formatted Text nodes
 * without pulling in the full card rendering tree.
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
jest.mock('../RichText.tsx', () => ({
  RichText: ({ content }: { content?: string }) => {
    const React = require('react');
    const { Text } = require('react-native');
    return React.createElement(Text, null, content ?? '');
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
// NOTE: intentionally exhaustive — FeaturedBadge imports lucide icons that
// require native module setup.
jest.mock('../FeaturedBadge.tsx', () => ({ FeaturedBadge: () => null }));
// NOTE: intentionally exhaustive — UserIdentityLink imports navigation context.
jest.mock('../interaction/UserIdentityLink.tsx', () => ({
  UserIdentityLink: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ── SharedPostCard — pass-through actionsSlot ────────────────────────────────
// The compact count text lives inside the actionsSlot prop.  Rendering it
// directly exercises the formatCompactCount call in each card variant without
// needing the full SharedPostCard dependency tree (CachedImage, StampIcon, etc.).
jest.mock('../cards/PostCard.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    PostCard: ({ actionsSlot }: { actionsSlot?: React.ReactNode }) =>
      React.createElement(View, { testID: 'shared-post-card' }, actionsSlot ?? null),
  };
});

// ── services ───────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — postEngagement makes real Supabase calls.
jest.mock('../../services/postEngagement.ts', () => ({ deletePost: jest.fn() }));
// NOTE: intentionally exhaustive — posts service makes real Supabase calls.
jest.mock('../../services/posts.ts', () => ({ hidePost: jest.fn() }));

// ── useStamp / useDoubleTapToStamp ────────────────────────────────────────────
// NOTE: intentionally exhaustive — useStamp hits Supabase reaction tables.
jest.mock('../../hooks/useStamp.ts', () => ({
  useStamp: () => ({ isStamped: false, count: 0, toggle: jest.fn() }),
}));
jest.mock('../../hooks/useDoubleTapToStamp.ts', () => ({
  useDoubleTapToStamp: (_single: unknown, _double: unknown) => jest.fn(),
}));

// ── PostCardStampBurst ─────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — uses Reanimated worklets + native bridge.
jest.mock('../stamps/PostCardStampBurst.tsx', () => {
  const React = require('react');
  return {
    PostCardStampBurst: React.forwardRef(() => null),
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

function makePlanItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'plan-1',
    type: 'plan',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: AUTHOR,
    title: 'Sunrise hike',
    attendeeCount: 0,
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

function makeQuestionItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'question-1',
    type: 'question',
    city: 'Berlin',
    timeAgo: '1h ago',
    tags: [],
    author: AUTHOR,
    question: 'Best rooftop bars?',
    replyCount: 0,
    featuredByPortava: null,
    // source !== 'user' → PostEngagementBar is not rendered, keeping mock surface minimal
    source: 'compass',
    ...overrides,
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PulseFeedCard PlanCard — compact attendeeCount', () => {
  it('renders "1.2K going" when attendeeCount is 1200', async () => {
    await render(<PulseFeedCard item={makePlanItem({ attendeeCount: 1200 })} />);

    expect(screen.getByText('1.2K going')).toBeTruthy();
    // Raw number must not appear
    expect(screen.queryByText('1200 going')).toBeNull();
  });

  it('renders "24K going" when attendeeCount is 24000', async () => {
    await render(<PulseFeedCard item={makePlanItem({ attendeeCount: 24_000 })} />);

    expect(screen.getByText('24K going')).toBeTruthy();
    expect(screen.queryByText('24000 going')).toBeNull();
  });

  it('renders "999 going" (no suffix) when attendeeCount is exactly 999', async () => {
    await render(<PulseFeedCard item={makePlanItem({ attendeeCount: 999 })} />);

    expect(screen.getByText('999 going')).toBeTruthy();
  });

  it('renders "1K going" when attendeeCount is exactly 1000', async () => {
    await render(<PulseFeedCard item={makePlanItem({ attendeeCount: 1000 })} />);

    expect(screen.getByText('1K going')).toBeTruthy();
    expect(screen.queryByText('1000 going')).toBeNull();
  });
});

describe('PulseFeedCard QuestionCard — compact replyCount', () => {
  it('renders "1.2K answers" when replyCount is 1200', async () => {
    await render(<PulseFeedCard item={makeQuestionItem({ replyCount: 1200 })} />);

    expect(screen.getByText('1.2K answers')).toBeTruthy();
    // Raw number must not appear
    expect(screen.queryByText('1200 answers')).toBeNull();
  });

  it('renders "2.5M answers" when replyCount is 2500000', async () => {
    await render(<PulseFeedCard item={makeQuestionItem({ replyCount: 2_500_000 })} />);

    expect(screen.getByText('2.5M answers')).toBeTruthy();
    expect(screen.queryByText('2500000 answers')).toBeNull();
  });

  it('renders "999 answers" (no suffix) when replyCount is exactly 999', async () => {
    await render(<PulseFeedCard item={makeQuestionItem({ replyCount: 999 })} />);

    expect(screen.getByText('999 answers')).toBeTruthy();
  });

  it('renders "1K answers" when replyCount is exactly 1000', async () => {
    await render(<PulseFeedCard item={makeQuestionItem({ replyCount: 1000 })} />);

    expect(screen.getByText('1K answers')).toBeTruthy();
    expect(screen.queryByText('1000 answers')).toBeNull();
  });
});
