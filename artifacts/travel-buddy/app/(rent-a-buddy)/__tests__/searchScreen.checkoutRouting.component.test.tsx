/**
 * search.tsx (RentABuddySearch) — results list checkout routing.
 *
 * Verifies that BuddyCard rendered in the results list receives an `onBook`
 * callback that navigates to `/(rent-a-buddy)/checkout` — not to request-buddy.
 *
 * Strategy: stub BuddyCard to capture the `onBook` prop, render the search
 * screen in results mode (via params), flush async search, then call the
 * captured callback and assert the destination.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — expo-router is mocked so we can assert on router.push.
// router.push uses jest.fn() inline so there is no hoisting issue.
// useLocalSearchParams is overridden per-test via mockParams.
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;

// ── safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── rentABuddy services ───────────────────────────────────────────────────────
const RESULT_BUDDY = {
  id: 'result-7', userId: 'user-result-7', displayName: 'Sophie',
  city: 'Paris', country: 'France', categories: ['culture'],
  languages: ['English', 'French'], verified: true, averageRating: 4.6,
  reviewCount: 22, hourlyRateUsd: 40, status: 'active',
  tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 3, distanceKm: null, buddyLevel: null,
  meetupBaseLat: null, meetupBaseLng: null,
};

// NOTE: intentional stub — only searchBuddies is exercised here.
jest.mock('../../../src/services/rentABuddy', () => ({
  searchBuddies: jest.fn().mockResolvedValue({
    ok: true,
    data: { buddies: [RESULT_BUDDY], total: 1 },
  }),
}));

// ── BuddyCard — prop-capture stub ─────────────────────────────────────────────
// NOTE: intentional stub — we capture onBook to verify the destination
// without pressing through BuddyCard's internals.
let capturedOnBook: (() => void) | undefined;
jest.mock('../../../src/components/BuddyCard', () => ({
  BuddyCard: ({ buddy, onBook }: { buddy: { id: string }; onBook?: () => void }) => {
    if (buddy.id === RESULT_BUDDY.id) capturedOnBook = onBook;
    return null;
  },
  BuddyCardSkeleton: () => null,
}));

// ── other components not under test ───────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives', () => ({
  TravelEmptyState: () => null,
  TravelErrorState: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow', () => ({
  CompassBuddyRow: () => null,
}));
// NOTE: intentional stub — theme tokens are exhaustive; avoids native
// font/shadow resolution that crashes jest-expo.
jest.mock('../../../src/theme/tokens', () => ({
  color:  { paperRaised: '#fff', haze: '#ccc', ink: '#000', onInk: '#fff', mute: '#999', warn: '#f59e0b', signal: '#e11d48', success: '#10b981', deep: '#1e3a5f', paper: '#faf9f6', faint: '#ddd' },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  shadow: { card: {}, float: {} },
  layout: { pressedOpacity: 0.7, hitSlop: 8 },
  type:   { small: {}, body: {}, bodyStrong: {}, heading: {}, title: {}, hero: {}, stamp: {} },
}));

import RentABuddySearch from '../search';

beforeEach(() => {
  routerPush.mockClear();
  capturedOnBook = undefined;
  // Start in results mode with a city pre-filled so doSearch fires on mount.
  mockParams = { city: 'Paris', category: 'culture' };
});

describe('search.tsx — results list onBook routing', () => {
  it('BuddyCard in results receives onBook that navigates to checkout', async () => {
    await render(<RentABuddySearch />);
    await act(async () => {});

    expect(capturedOnBook).toBeDefined();
    capturedOnBook!();

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: RESULT_BUDDY.id }),
      }),
    );
  });

  it('results list onBook does NOT navigate to request-buddy', async () => {
    await render(<RentABuddySearch />);
    await act(async () => {});

    capturedOnBook?.();

    const wentToRequestBuddy = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && String(arg?.pathname ?? '').includes('request-buddy'),
    );
    expect(wentToRequestBuddy).toBe(false);
  });
});
