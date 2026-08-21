/**
 * search.tsx (RentABuddySearch) — results list checkout routing.
 *
 * Verifies that ProfileCard rendered in the results list receives an `onPress`
 * callback that navigates to `/(rent-a-buddy)/checkout` — not to request-buddy.
 *
 * Strategy: stub ProfileCard to capture the `onPress` prop, render the search
 * screen in results mode (via params), flush async search, then call the
 * captured callback and assert the destination.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — expo-router is mocked so we can assert on router.push.
// router.push uses jest.fn() inline so there is no hoisting issue.
// useLocalSearchParams is overridden per-test via mockParams.
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;
const routerSetParams = router.setParams as jest.Mock;

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
import { searchBuddies } from '../../../src/services/rentABuddy';
const mockSearchBuddies = searchBuddies as jest.Mock;

// ── ProfileCard — prop-capture stub ───────────────────────────────────────────
// NOTE: intentional stub — we capture onPress to verify the destination
// without pressing through ProfileCard's internals.
let capturedOnPress: (() => void) | undefined;
jest.mock('../../../src/components/cards/ProfileCard', () => ({
  ProfileCard: ({ id, onPress }: { id: string; onPress?: () => void }) => {
    if (id === RESULT_BUDDY.id) capturedOnPress = onPress;
    return null;
  },
}));

// ── ProfileSkeleton ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/ProfileSkeleton', () => ({
  ProfileSkeleton: () => null,
}));

// ── EmptyState / ErrorState ────────────────────────────────────────────────────
// NOTE: intentional stubs — not under test here.
jest.mock('../../../src/components/ui/EmptyState', () => ({
  EmptyState: () => null,
}));
jest.mock('../../../src/components/ui/ErrorState', () => ({
  ErrorState: () => null,
}));

// ── LocationContext ───────────────────────────────────────────────────────────
// NOTE: intentional stub — RentABuddySearch reads resolvedLocation for a
// coordinate fallback; provider is not under test here.
const mockSetSessionLocation = jest.fn();
const mockClearSessionLocation = jest.fn();
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { place: { city: null }, coords: null },
    setSessionLocation: mockSetSessionLocation,
    clearSessionLocation: mockClearSessionLocation,
  }),
}));

// ── other components not under test ───────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — not under test here.
let capturedOnSelect: ((place: any) => void) | undefined;
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: ({ onSelect }: { onSelect?: (place: any) => void }) => {
    capturedOnSelect = onSelect;
    return null;
  },
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow', () => ({
  CompassBuddyRow: () => null,
}));
// NOTE: intentional stub — theme tokens are exhaustive; avoids native
// font/shadow resolution that crashes jest-expo.

import RentABuddySearch from '../search';

beforeEach(() => {
  routerPush.mockClear();
  routerSetParams.mockClear();
  mockSetSessionLocation.mockClear();
  mockClearSessionLocation.mockClear();
  mockSearchBuddies.mockClear();
  capturedOnPress = undefined;
  capturedOnSelect = undefined;
  // Start in results mode with a city pre-filled so doSearch fires on mount.
  mockParams = { city: 'Paris', category: 'culture' };
});

describe('search.tsx — selected city propagation', () => {
  it('updates context and route params, then searches with the selected city and coordinates', async () => {
    await render(<RentABuddySearch />);
    await act(async () => {});
    mockSearchBuddies.mockClear();

    const lisbon = { city: 'Lisbon', name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
    await act(async () => {
      capturedOnSelect?.(lisbon);
    });

    expect(mockSetSessionLocation).toHaveBeenCalledWith(lisbon);
    expect(routerSetParams).toHaveBeenCalledWith({
      city: 'Lisbon',
      lat: '38.7223',
      lng: '-9.1393',
    });
    await waitFor(() => expect(mockSearchBuddies).toHaveBeenCalledWith(
      expect.objectContaining({
        city: 'Lisbon',
        lat: 38.7223,
        lng: -9.1393,
      }),
    ));
  });
});

describe('search.tsx — results list onPress routing', () => {
  it('ProfileCard in results receives onPress that navigates to checkout', async () => {
    await render(<RentABuddySearch />);
    await act(async () => {});

    expect(capturedOnPress).toBeDefined();
    capturedOnPress!();

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: RESULT_BUDDY.id }),
      }),
    );
  });

  it('results list onPress does NOT navigate to request-buddy', async () => {
    await render(<RentABuddySearch />);
    await act(async () => {});

    capturedOnPress?.();

    const wentToRequestBuddy = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && String(arg?.pathname ?? '').includes('request-buddy'),
    );
    expect(wentToRequestBuddy).toBe(false);
  });
});
