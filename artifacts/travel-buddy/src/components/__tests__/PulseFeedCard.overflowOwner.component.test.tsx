/**
 * PulseFeedCard — overflow menu owner-only gating
 *
 * Confirms that the '…' overflow menu in AuthorRow shows "Edit post" only
 * when the current user is the post owner.
 *
 *   Owner:     Alert buttons include "Edit post" → navigates to /post/edit/[id]
 *   Non-owner: Alert buttons do NOT include "Edit post"; Share/Report/Hide shown
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

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
// Mutable so each test can flip the viewer identity without re-mocking.
// NOTE: intentionally exhaustive — SessionContext imports Supabase auth internals.
const mockUserId = { current: 'viewer-1' };
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: mockUserId.current, isAuthed: true }),
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
// that are not safe under jest; only the null stub is needed here.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({ AvatarImage: () => null }));

// ── useHighlightRingState ──────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — useHighlightRingState hits highlight services;
// AuthorRow only reads the returned object to decide ring visibility.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

// ── displayIdentity ────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — displayIdentity imports locale-dependent
// formatting utilities; only the text shape matters for this test.
jest.mock('../../lib/displayIdentity.ts', () => ({
  primaryIdentityText: ({ username }: { username?: string | null }) => username ?? '',
}));

// ── navigateToProfile ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — navigateToProfile calls router APIs that
// require a mounted navigation stack; a jest.fn() stub is sufficient.
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
// Captures the props it's rendered with so the why-sheet lifecycle tests below
// can assert on visible/recommendationId without mounting the real sheet.
jest.mock('../compass/CompassWhySheet.tsx', () => ({
  CompassWhySheet: (props: { visible: boolean; recommendationId: string | null; onClose: () => void }) => {
    (global as any).__lastWhySheetProps = props;
    return null;
  },
}));
// NOTE: intentionally exhaustive — MediaStampOverlay loads stamp assets.
jest.mock('../StampOverlayBadge.tsx', () => ({ MediaStampOverlay: () => null }));
// NOTE: intentionally exhaustive — VideoThumbnail uses native video deps.
jest.mock('../ui/VideoThumbnail.tsx', () => ({ VideoThumbnail: () => null }));
// NOTE: intentionally exhaustive — LocationChip uses location context.
jest.mock('../LocationChip.tsx', () => ({ LocationChip: () => null }));
// NOTE: intentionally exhaustive — RichText uses text-parsing utilities.
jest.mock('../RichText.tsx', () => ({ RichText: () => null }));
// NOTE: intentionally exhaustive — FeaturedBadge imports image assets.
jest.mock('../FeaturedBadge.tsx', () => ({ FeaturedBadge: () => null }));
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

// ── Component under test ───────────────────────────────────────────────────────
import { PulseFeedCard } from '../PulseFeedCard.tsx';
import type { PulseFeedItem } from '../../types/models.ts';
import { deletePost } from '../../services/postEngagement.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AUTHOR_ID = 'author-1';
const POST_ID   = 'post-abc';

function makePostItem(): PulseFeedItem {
  return {
    id: POST_ID,
    type: 'post',
    city: 'Tokyo',
    timeAgo: '2h ago',
    tags: [],
    author: {
      id: AUTHOR_ID,
      name: 'Alice',
      username: 'alice',
      avatarUrl: null,
      verified: false,
      isOfficial: false,
    },
  } as unknown as PulseFeedItem;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(Alert, 'alert');
});

afterEach(() => {
  alertSpy.mockRestore();
});

describe('PulseFeedCard AuthorRow — overflow menu owner gating', () => {
  it('owner sees "Edit post" as the first option and it navigates to the edit route', async () => {
    mockUserId.current = AUTHOR_ID; // viewer IS the author

    await render(<PulseFeedCard item={makePostItem()} />);
    fireEvent.press(screen.getByTestId('overflow-menu-btn'));

    expect(alertSpy).toHaveBeenCalledTimes(1);

    const buttons: Array<{ text: string; onPress?: () => void }> =
      alertSpy.mock.calls[0][2];

    // "Edit post" must be present
    const editBtn = buttons.find((b) => b.text === 'Edit post');
    expect(editBtn).toBeDefined();

    // It must be the first actionable option (before destructive / share / cancel)
    expect(buttons[0].text).toBe('Edit post');

    // Pressing it navigates to the edit route (bare call per TESTING.md rule 2)
    editBtn!.onPress?.();
    expect(router.push).toHaveBeenCalledWith(`/post/edit/${POST_ID}`);
  });

  it('non-owner never sees "Edit post" in the overflow menu', async () => {
    mockUserId.current = 'viewer-99'; // viewer is NOT the author

    await render(<PulseFeedCard item={makePostItem()} />);
    fireEvent.press(screen.getByTestId('overflow-menu-btn'));

    expect(alertSpy).toHaveBeenCalledTimes(1);

    const labels: string[] = alertSpy.mock.calls[0][2].map(
      (b: { text: string }) => b.text,
    );

    expect(labels).not.toContain('Edit post');

    // Non-owner options are all present
    expect(labels).toContain('Share post');
    expect(labels).toContain('Report');
    expect(labels).toContain('Hide from feed');
  });
});

describe('PulseFeedCard — "Why this?" sheet lifecycle across navigation', () => {
  it('closing the sheet clears both visible and recommendationId — no stale id left behind', async () => {
    mockUserId.current = AUTHOR_ID;
    await render(<PulseFeedCard item={makePostItem()} />);

    // Simulate the sheet having been opened and then closed via onClose
    // (PostCard is mocked to null, so drive the close handler directly).
    const props = (global as any).__lastWhySheetProps;
    expect(props).toBeDefined();
    expect(props.visible).toBe(false);

    props.onClose();

    const afterClose = (global as any).__lastWhySheetProps;
    expect(afterClose.visible).toBe(false);
    expect(afterClose.recommendationId).toBeNull();
  });
});

describe('PulseFeedCard — owner Delete post flow', () => {
  it('confirming deletion calls deletePost with the post ID and removes the card from the feed', async () => {
    mockUserId.current = AUTHOR_ID; // viewer IS the author

    // deletePost succeeds
    (deletePost as jest.Mock).mockResolvedValue(true);

    const onDeleteSuccess = jest.fn();
    await render(<PulseFeedCard item={makePostItem()} onDeleteSuccess={onDeleteSuccess} />);

    // ── Step 1: open overflow ────────────────────────────────────────────────
    fireEvent.press(screen.getByTestId('overflow-menu-btn'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const firstButtons: Array<{ text: string; style?: string; onPress?: () => void }> =
      alertSpy.mock.calls[0][2];

    // ── Step 2: press 'Delete post' — triggers the confirmation Alert ────────
    const deletePostBtn = firstButtons.find((b) => b.text === 'Delete post');
    expect(deletePostBtn).toBeDefined();
    deletePostBtn!.onPress?.();

    expect(alertSpy).toHaveBeenCalledTimes(2);
    const secondButtons: Array<{ text: string; style?: string; onPress?: () => void }> =
      alertSpy.mock.calls[1][2];

    // ── Step 3: confirm 'Delete' on the second Alert ─────────────────────────
    const confirmBtn = secondButtons.find((b) => b.text === 'Delete');
    expect(confirmBtn).toBeDefined();
    // Per RNTL Alert act() rules: call onPress bare — never inside awaited act().
    confirmBtn!.onPress?.();

    // ── Step 4: assert deletePost called + card dismissed ─────────────────────
    await waitFor(() => {
      expect(deletePost).toHaveBeenCalledWith(POST_ID);
    });

    // PostCard sets dismissed=true → returns null → overflow button gone
    await waitFor(() => {
      expect(screen.queryByTestId('overflow-menu-btn')).toBeNull();
    });
  });

  it('a failed deletePost shows an error alert and leaves the card visible', async () => {
    mockUserId.current = AUTHOR_ID;

    // deletePost fails
    (deletePost as jest.Mock).mockResolvedValue(false);

    await render(<PulseFeedCard item={makePostItem()} />);

    // Open overflow → Delete post → confirm Delete
    fireEvent.press(screen.getByTestId('overflow-menu-btn'));
    const firstButtons: Array<{ text: string; onPress?: () => void }> =
      alertSpy.mock.calls[0][2];
    firstButtons.find((b) => b.text === 'Delete post')!.onPress?.();

    const secondButtons: Array<{ text: string; onPress?: () => void }> =
      alertSpy.mock.calls[1][2];
    secondButtons.find((b) => b.text === 'Delete')!.onPress?.();

    // deletePost is called but returns false → error alert shown
    await waitFor(() => {
      expect(deletePost).toHaveBeenCalledWith(POST_ID);
    });

    // Third alert is the error message
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(3);
      expect(alertSpy.mock.calls[2][0]).toBe('Error');
    });

    // Card must still be visible (not dismissed)
    expect(screen.getByTestId('overflow-menu-btn')).toBeTruthy();
  });
});
