/**
 * PulseFeedCard — CircleCard participant avatar tappability
 *
 * Confirms that each avatar in the CircleCard participant stack is wrapped in
 * UserIdentityLink and navigates to the correct user profile when tapped.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — spreading requireActual pulls in native modules
// that crash the JS-only renderer; only `router.push` and `useLocalSearchParams`
// are consumed here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

import { router } from 'expo-router';

// ── SessionContext ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — SessionContext imports Supabase auth internals;
// CircleCard only uses useSession for currentUserId.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// ── BlockedIdsContext ─────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — BlockedIdsContext pulls Supabase realtime;
// UserIdentityLink only needs blockedIds/blockerIds Sets.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set(), isLoading: false }),
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context pulls native-module
// internals not safe under jest; only inset values are consumed by downstream imports.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.useReducedMotion = () => false;
  return Reanimated;
});

// ── PlanPickerController ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real provider requires navigation context;
// CircleCard does not use planPicker at all, but other card variants imported
// from the same file do.
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — expo-linear-gradient pulls a native gradient
// module; LinearGradient is only used in PostCard's scrim, not in CircleCard.
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ── CachedImage ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — CachedImage imports Supabase storage helpers;
// the avatar src value is irrelevant to tap routing.
jest.mock('../CachedImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CachedImage: () => React.createElement(View, null),
    withStorageParams: (uri: string) => uri,
  };
});

// NOTE: intentionally exhaustive — useHighlightRingState hits highlight services;
// CircleCard doesn't use it but AuthorRow (other card variants) does.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

// NOTE: intentionally exhaustive — displayIdentity imports formatting utils with
// locale deps; only the text shape matters for this test.
jest.mock('../../lib/displayIdentity.ts', () => ({
  primaryIdentityText: ({ username }: { username?: string | null }) => username ?? '',
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

// NOTE: intentionally exhaustive — these components pull in navigation/native deps
// unrelated to the CircleCard avatar-tap behavior under test; rendering null is safe.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));
// NOTE: intentionally exhaustive — ReportPostSheet requires modal native deps.
jest.mock('../ReportPostSheet.tsx', () => ({ ReportPostSheet: () => null }));
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

// ── Component under test ───────────────────────────────────────────────────────
import { PulseFeedCard } from '../PulseFeedCard.tsx';
import type { PulseFeedItem } from '../../types/models.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeCircleItem(participants: PulseFeedItem['participants']): PulseFeedItem {
  return {
    id: 'feed-circle-1',
    type: 'circle_activity',
    city: 'Cebu City',
    activityText: 'Three people joined your circle',
    participants,
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PulseFeedCard CircleCard — participant avatar tappability', () => {
  it('navigates to the first participant profile when their avatar is tapped', async () => {
    const item = makeCircleItem([
      { id: 'p-1', name: 'Alice', avatarUrl: 'https://example.com/a.jpg', username: 'alice' },
      { id: 'p-2', name: 'Bob',   avatarUrl: 'https://example.com/b.jpg', username: 'bob' },
    ]);

    await render(<PulseFeedCard item={item} />);

    fireEvent.press(screen.getByTestId('identity-link-p-1'));

    expect(router.push).toHaveBeenCalledWith('/u/alice');
  });

  it('navigates to a second participant profile when their avatar is tapped', async () => {
    const item = makeCircleItem([
      { id: 'p-1', name: 'Alice', avatarUrl: 'https://example.com/a.jpg', username: 'alice' },
      { id: 'p-2', name: 'Bob',   avatarUrl: 'https://example.com/b.jpg', username: 'bob' },
    ]);

    await render(<PulseFeedCard item={item} />);

    fireEvent.press(screen.getByTestId('identity-link-p-2'));

    expect(router.push).toHaveBeenCalledWith('/u/bob');
  });

  it('does not navigate when the participant has no username', async () => {
    const item = makeCircleItem([
      { id: 'p-no-handle', name: 'Ghost', avatarUrl: 'https://example.com/g.jpg', username: null },
    ]);

    await render(<PulseFeedCard item={item} />);

    fireEvent.press(screen.getByTestId('identity-link-p-no-handle'));

    expect(router.push).not.toHaveBeenCalled();
  });
});
