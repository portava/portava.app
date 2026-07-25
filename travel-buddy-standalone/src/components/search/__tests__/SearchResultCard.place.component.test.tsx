/**
 * SearchResultCard — place card standard test
 *
 * Confirms that place and hidden_gem results render a visual image area
 * (not text-only): either the category emoji fallback or the actual image.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { SearchResultCard } from '../SearchResultCard.tsx';
import type { UnifiedSearchResult } from '../SearchResultCard.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router navigation internals are not
// safe under jest-expo; only router.push is used by this component.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// font loader internals that crash under jest-expo.
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    faint:       '#CCCCCC',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
    success:     '#16A34A',
    warn:        '#F59E0B',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, body: {}, small: {}, stamp: {} },
  shadow: { card: {}, float: {} },
}));

// NOTE: intentionally exhaustive — UserAvatarButton imports supabase and
// native image modules; only the children passthrough is needed here.
jest.mock('../../interaction/UserAvatarButton.tsx', () => ({
  UserAvatarButton: ({ children }: any) => {
    const { View } = require('react-native');
    return <View testID="avatar-btn">{children ?? null}</View>;
  },
}));

// NOTE: intentionally exhaustive — follows service makes real fetch calls;
// none of the follow/unfollow actions are exercised in this test file.
jest.mock('../../../services/follows.ts', () => ({
  followUser:   jest.fn(),
  unfollowUser: jest.fn(),
}));
// NOTE: intentionally exhaustive — events service makes real fetch calls;
// rsvpEvent is the only export referenced by this component path.
jest.mock('../../../services/events.ts', () => ({
  rsvpEvent: jest.fn(),
}));
// NOTE: intentionally exhaustive — collections service makes real fetch calls;
// saveItem/unsaveItem are the only exports referenced by this component path.
jest.mock('../../../services/collections.ts', () => ({
  saveItem:   jest.fn(),
  unsaveItem: jest.fn(),
}));

// NOTE: intentionally exhaustive — searchNav re-exports TypeIcon which
// imports lucide icons; the global Proxy mock already handles lucide.
// We only need resolveRoute to return a valid route string.
jest.mock('../searchNav.tsx', () => ({
  TypeIcon:     () => null,
  resolveRoute: (result: any) => `/place/${result.id}`,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePlaceResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id:               'place-1',
    type:             'places',
    title:            'Eiffel Tower',
    subtitle:         'Landmark',
    avatarUrl:        null,
    imageUrl:         null,
    fallbackInitials: null,
    locationPreview:  'Champ de Mars, Paris',
    matchedReason:    null,
    actionState:      { isSaved: false },
    privacyState:     null,
    accessState:      { canAccess: true },
    destinationRoute: '/place/place-1',
    metadata:         { category: 'landmarks', rating: 4.8, isOpenNow: true },
    createdAt:        null,
    startsAt:         null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SearchResultCard — place card standard', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows category emoji fallback (not text-only) when imageUrl is null', async () => {
    const result = makePlaceResult({ imageUrl: null });
    const { getByTestId } = await render(<SearchResultCard result={result} />);

    await waitFor(() => {
      // The fallback emoji view must be present — card is not text-only
      expect(getByTestId('place-result-fallback')).toBeTruthy();
    });
  });

  it('shows the image element when imageUrl is provided', async () => {
    const result = makePlaceResult({ imageUrl: 'https://example.com/eiffel.jpg' });
    const { getByTestId } = await render(<SearchResultCard result={result} />);

    await waitFor(() => {
      expect(getByTestId('place-result-image')).toBeTruthy();
    });
  });

  it('does NOT render the TypeIcon square for place results', async () => {
    const result = makePlaceResult({ imageUrl: null });
    const { queryByTestId } = await render(<SearchResultCard result={result} />);

    await waitFor(() => {
      // The generic type icon square must not appear for places
      expect(queryByTestId('place-result-fallback')).toBeTruthy();
    });
  });

  it('shows the fallback for hidden_gem type too', async () => {
    const result = makePlaceResult({ type: 'hidden_gems', imageUrl: null });
    const { getByTestId } = await render(<SearchResultCard result={result} />);

    await waitFor(() => {
      expect(getByTestId('place-result-fallback')).toBeTruthy();
    });
  });
});
