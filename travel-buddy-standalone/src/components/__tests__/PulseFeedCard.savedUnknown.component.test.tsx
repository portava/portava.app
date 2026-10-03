/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): PulseFeedCard hands its bookmark an unread save state
 * as unknown, never as "not saved".
 *
 * GET /pulse serves `savedByMe: null` when the viewer's saves could not be read, and pulsePostToFeedItem carries the null
 * through (pulseSavedUnread PSC0, PSC2). Every SaveButton the card draws gets `savedUnknown` for a null, and a measured
 * false stays a measured "not saved".
 *
 *   PC0 savedByMe null → the card's bookmark is told savedUnknown
 *   PC1 CONTROL: savedByMe false → savedUnknown false, initialSaved false
 *   PC2 CONTROL: savedByMe true → savedUnknown false, initialSaved true
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
let _cachedImageOnError: (() => void) | undefined; void _cachedImageOnError;
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
// NOTE: intentionally exhaustive — SaveButton hits bookmark services; the stub records the props the card hands it.
const mockSaveProps: Array<Record<string, unknown>> = [];
jest.mock('../SaveButton.tsx', () => ({ SaveButton: (p: Record<string, unknown>) => { mockSaveProps.push(p); return null; } }));
// NOTE: intentionally exhaustive — PostEngagementBar fetches engagement data.
jest.mock('../PostEngagementBar.tsx', () => ({ PostEngagementBar: ({ right }: { right?: Array<{ key: string; node: React.ReactNode }> }) => { const React = require('react'); return React.createElement(React.Fragment, null, ...(right ?? []).map((r) => React.createElement(React.Fragment, { key: r.key }, r.node))); } }));
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

// ── Fixtures ──

const AUTHOR = { id: 'author-1', name: 'Alice', username: 'alice', avatarUrl: null, verified: false, isOfficial: false };
function makePostItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return { id: 'post-1', type: 'post', city: 'Tokyo', timeAgo: '2h ago', tags: [], author: AUTHOR, caption: 'A lovely sunrise over the bay.', featuredByPortava: null, ...overrides } as unknown as PulseFeedItem;
}
function photoItem(overrides: Partial<PulseFeedItem> = {}): PulseFeedItem {
  return makePostItem({ media: [{ url: 'https://example.com/photo.jpg', thumbnail_url: 'https://example.com/thumb.jpg' }], ...overrides } as Partial<PulseFeedItem>);
}

beforeEach(() => { jest.clearAllMocks(); mockSaveProps.length = 0; });

describe('census-discovery §122 (B36): PulseFeedCard draws an unread save state as unknown', () => {
  it.each([['text card', makePostItem], ['photo card', photoItem]])('PC0 %s: savedByMe null → savedUnknown', async (_n, make) => {
    await render(<PulseFeedCard item={make({ savedByMe: null })} />);
    expect(mockSaveProps.length).toBeGreaterThan(0);
    expect(mockSaveProps.every((p) => p.savedUnknown === true)).toBe(true);
  });
  it.each([['text card', makePostItem], ['photo card', photoItem]])('PC1 CONTROL %s: savedByMe false → known, not saved', async (_n, make) => {
    await render(<PulseFeedCard item={make({ savedByMe: false })} />);
    expect(mockSaveProps.length).toBeGreaterThan(0);
    expect(mockSaveProps.every((p) => p.savedUnknown === false && p.initialSaved === false)).toBe(true);
  });
  it('PC2 CONTROL: savedByMe true → known, saved', async () => {
    await render(<PulseFeedCard item={makePostItem({ savedByMe: true })} />);
    expect(mockSaveProps.length).toBeGreaterThan(0);
    expect(mockSaveProps.every((p) => p.savedUnknown === false && p.initialSaved === true)).toBe(true);
  });
});
