/**
 * PulseFeedCard — CTA button handler wiring
 *
 * Confirms that the 'Add to Plan', 'Join Plan', 'Use this plan',
 * 'See Circle', and 'View Details' Pressable elements inside PlanCard,
 * ItineraryCard, CircleCard, and CompassCard each fire the expected
 * navigation or picker call when pressed.
 *
 * Uses fireEvent.press (not hitSlop geometry) — tests handler wiring only.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

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

import { router } from 'expo-router';

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
// Capture `open` so tests can assert it was called with the correct payload.
const mockPlanPickerOpen = jest.fn();
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: mockPlanPickerOpen, isAdded: () => false }),
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

// ── compassFormat ──────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports place-resolution services.
jest.mock('../../utils/compassFormat.ts', () => ({
  resolveCompassTitle: () => 'Compass Title',
  formatCompassSubtitle: () => null,
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

// ── SharedPostCard — renders actionsSlot so CTA buttons are reachable ─────────
// NOTE: intentionally exhaustive — PostCard pulls in its own icon/image deps.
jest.mock('../cards/PostCard.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    PostCard: ({ actionsSlot }: { actionsSlot?: React.ReactNode }) =>
      React.createElement(View, { testID: 'post-card-stub' }, actionsSlot),
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

function makePlanItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'plan-1',
    type: 'plan',
    title: 'Weekend Hike',
    city: 'Kyoto',
    timeAgo: '1h ago',
    tags: [],
    author: AUTHOR,
    attendeeCount: 3,
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

function makeItineraryItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'itin-1',
    type: 'itinerary',
    title: '3-Day Tokyo',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: AUTHOR,
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

function makeCircleItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'circle-1',
    type: 'circle_activity',
    city: 'Seoul',
    activityText: 'Two people joined your circle',
    participants: [],
    ...overrides,
  } as unknown as PulseFeedItem;
}

function makeCompassItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return {
    id: 'compass-1',
    type: 'compass_suggestion',
    title: 'Hidden Café',
    city: 'Lisbon',
    timeAgo: '3h ago',
    tags: [],
    reason: 'Matches your coffee preference',
    featuredByPortava: null,
    ...overrides,
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── PlanCard ──────────────────────────────────────────────────────────────────

describe('PulseFeedCard PlanCard — CTA button handler wiring', () => {
  it('"Add to Plan" opens the plan picker with the correct payload', async () => {
    await render(<PulseFeedCard item={makePlanItem()} />);

    fireEvent.press(screen.getByTestId('plan-card-add-to-plan-btn'));

    expect(mockPlanPickerOpen).toHaveBeenCalledTimes(1);
    expect(mockPlanPickerOpen).toHaveBeenCalledWith({
      id: 'plan-1',
      type: 'plan',
      title: 'Weekend Hike',
      city: 'Kyoto',
      category: 'meeting_point',
    });
  });

  it('"Add to Plan" falls back to "Meetup" when the item has no title', async () => {
    await render(<PulseFeedCard item={makePlanItem({ title: undefined })} />);

    fireEvent.press(screen.getByTestId('plan-card-add-to-plan-btn'));

    expect(mockPlanPickerOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Meetup' }),
    );
  });

  it('"Join Plan" routes to the related trip when relatedTripId is set', async () => {
    await render(<PulseFeedCard item={makePlanItem({ relatedTripId: 'trip-99' })} />);

    fireEvent.press(screen.getByTestId('plan-card-join-plan-btn'));

    expect(router.push).toHaveBeenCalledWith('/trip/trip-99');
  });

  it('"Join Plan" routes to the trips tab when no relatedTripId is set', async () => {
    await render(<PulseFeedCard item={makePlanItem({ relatedTripId: null })} />);

    fireEvent.press(screen.getByTestId('plan-card-join-plan-btn'));

    expect(router.push).toHaveBeenCalledWith('/(tabs)/trips');
  });
});

// ── ItineraryCard ─────────────────────────────────────────────────────────────

describe('PulseFeedCard ItineraryCard — CTA button handler wiring', () => {
  it('"Use this plan" opens the plan picker with the correct payload', async () => {
    await render(<PulseFeedCard item={makeItineraryItem()} />);

    fireEvent.press(screen.getByTestId('itinerary-card-use-this-plan-btn'));

    expect(mockPlanPickerOpen).toHaveBeenCalledTimes(1);
    expect(mockPlanPickerOpen).toHaveBeenCalledWith({
      id: 'itin-1',
      type: 'experience',
      title: '3-Day Tokyo',
      city: 'Tokyo',
      category: 'Itinerary',
    });
  });

  it('"Use this plan" falls back to "Itinerary" title when item has no title', async () => {
    await render(<PulseFeedCard item={makeItineraryItem({ title: undefined })} />);

    fireEvent.press(screen.getByTestId('itinerary-card-use-this-plan-btn'));

    expect(mockPlanPickerOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Itinerary' }),
    );
  });
});

// ── CircleCard ────────────────────────────────────────────────────────────────

describe('PulseFeedCard CircleCard — CTA button handler wiring', () => {
  it('"See Circle" routes to /circle', async () => {
    await render(<PulseFeedCard item={makeCircleItem()} />);

    fireEvent.press(screen.getByTestId('circle-card-see-circle-btn'));

    expect(router.push).toHaveBeenCalledWith('/circle');
  });
});

// ── CompassCard ───────────────────────────────────────────────────────────────

describe('PulseFeedCard CompassCard — CTA button handler wiring', () => {
  it('"View Details" routes to the AI tab', async () => {
    await render(<PulseFeedCard item={makeCompassItem()} />);

    fireEvent.press(screen.getByTestId('compass-card-view-details-btn'));

    expect(router.push).toHaveBeenCalledWith('/(tabs)/ai');
  });

  it('"Add to Plan" opens the plan picker with the correct payload', async () => {
    await render(<PulseFeedCard item={makeCompassItem()} />);

    fireEvent.press(screen.getByTestId('compass-card-add-to-plan-btn'));

    expect(mockPlanPickerOpen).toHaveBeenCalledTimes(1);
    expect(mockPlanPickerOpen).toHaveBeenCalledWith({
      id: 'compass-1',
      type: 'compass_suggestion',
      title: 'Compass Title',   // resolved via the mocked resolveCompassTitle
      city: 'Lisbon',
      category: 'Compass',
    });
  });
});
