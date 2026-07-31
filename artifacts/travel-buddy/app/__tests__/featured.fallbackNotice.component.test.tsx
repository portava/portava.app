/**
 * FeaturedHubScreen — @Portava fallback banner visibility tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When `getFeaturedHub` returns `isFallback: true`, the FallbackNotice
 *    banner ("✨ Showcasing @Portava's top posts…") is rendered inside the
 *    FlatList section list.
 *
 * 2. When `getFeaturedHub` returns `isFallback: false` (or the field is
 *    absent), the banner is not rendered at all.
 *
 * ## Why these tests exist
 *
 * Task #3190 added the FallbackNotice component and wired it to the
 * `isFallback` flag from the API.  The API-side fallback logic already has
 * coverage; these tests confirm the mobile component actually reads the flag
 * and shows or hides the banner as expected.
 *
 * ## Mock strategy
 *
 * Only the direct dependencies of featured.tsx are mocked:
 *  - `getFeaturedHub` — controlled to inject the isFallback flag.
 *  - expo-router — router.push/back are no-ops; useFocusEffect runs via useEffect.
 *  - react-native-safe-area-context — returns zero insets.
 * lucide-react-native is NOT mocked here; the global Proxy (moduleNameMapper)
 * covers it and must not be overridden per-file.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import FeaturedHubScreen from '../featured.tsx';
import { getFeaturedHub } from '../../src/services/featured.ts';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real expo-router pulls in native
// navigation bindings and Reanimated hooks not safe to run under Jest.
jest.mock('expo-router', () => ({
  router: {
    push:     jest.fn(),
    back:     jest.fn(),
    replace:  jest.fn(),
    navigate: jest.fn(),
  },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/featured',
  useSegments:          () => [],
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── getFeaturedHub ────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real service makes a fetch() call to
// the API server which is not available in the Jest environment.
jest.mock('../../src/services/featured', () => ({
  getFeaturedHub: jest.fn(),
}));

const mockGetFeaturedHub = getFeaturedHub as jest.MockedFunction<typeof getFeaturedHub>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FALLBACK_NOTICE_TEXT =
  "✨ Showcasing @Portava's top posts while new featured selections are being curated.";

function makePost(id: string) {
  return {
    id,
    postId:         `post-${id}`,
    category:       'best_hidden_gem' as const,
    categoryLabel:  'Best Hidden Gem',
    featuredAt:     '2026-07-01T00:00:00Z',
    caption:        'A great place',
    thumbnailUrl:   null,
    mediaType:      'image' as const,
    author: {
      id:          'user-1',
      username:    'portava',
      displayName: '@portava',
      avatarUrl:   null,
    },
    locationCity:    'Lisbon',
    locationCountry: 'Portugal',
  };
}

const BASE_RESULT = {
  groups: [
    {
      category:      'best_hidden_gem',
      categoryLabel: 'Best Hidden Gem',
      posts:         [makePost('p1'), makePost('p2')],
    },
  ],
  thisWeeksWinners: [makePost('w1')],
  total: 2,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FeaturedHubScreen — @Portava fallback banner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the fallback notice when isFallback is true', async () => {
    mockGetFeaturedHub.mockResolvedValue({
      ok:   true,
      data: { ...BASE_RESULT, isFallback: true },
    });

    const { queryByText } = await render(<FeaturedHubScreen />);

    await waitFor(() => {
      expect(queryByText(FALLBACK_NOTICE_TEXT)).not.toBeNull();
    });
  });

  it('does not render the fallback notice when isFallback is false', async () => {
    mockGetFeaturedHub.mockResolvedValue({
      ok:   true,
      data: { ...BASE_RESULT, isFallback: false },
    });

    const { queryByText } = await render(<FeaturedHubScreen />);

    await waitFor(() => {
      // Wait for loading to finish (a group heading is visible)
      expect(queryByText('Best Hidden Gem')).not.toBeNull();
    });

    expect(queryByText(FALLBACK_NOTICE_TEXT)).toBeNull();
  });

  it('does not render the fallback notice when isFallback is absent', async () => {
    mockGetFeaturedHub.mockResolvedValue({
      ok:   true,
      data: { ...BASE_RESULT },   // isFallback field omitted entirely
    });

    const { queryByText } = await render(<FeaturedHubScreen />);

    await waitFor(() => {
      expect(queryByText('Best Hidden Gem')).not.toBeNull();
    });

    expect(queryByText(FALLBACK_NOTICE_TEXT)).toBeNull();
  });
});
