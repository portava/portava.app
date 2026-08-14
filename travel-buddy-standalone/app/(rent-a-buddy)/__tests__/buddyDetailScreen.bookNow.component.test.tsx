/**
 * buddy/[id].tsx — "Book Now" sticky button and PackageCard routing tests.
 *
 * Verifies that:
 *   - The "Book Now" sticky button in the buddy detail screen navigates to
 *     `/(rent-a-buddy)/checkout` with `buddyId` set.
 *   - The PackageCard "Book This Package" button navigates to checkout with
 *     both `buddyId` and `packageId` set.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — expo-router is mocked so we can assert on router.push.
// router.push uses jest.fn() inline so there is no hoisting issue.
// useLocalSearchParams is overridden per-test via mockSearchParams.
let mockSearchParams: Record<string, string> = { id: 'buddy-77' };
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockSearchParams,
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
  useRouter: () => ({ push: jest.fn() }),
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;

// ── safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useStickyBarInset:     () => ({ inset: 100, onBarLayout: () => {} }),
  usePlainBottomInset:   () => 100,
  PlainBottomFiller:     () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useKeyboardVisible:    () => false,
  useBottomInset:        () => 100,
  useLayoverAwareBottomInset: () => 100,
}));

// ── rentABuddy services ───────────────────────────────────────────────────────
const BUDDY = {
  id: 'buddy-77',
  userId: 'user-77',
  displayName: 'Carlos',
  city: 'Mexico City',
  country: 'Mexico',
  categories: ['city', 'food'],
  languages: ['English', 'Spanish'],
  verified: true,
  averageRating: 4.8,
  reviewCount: 18,
  hourlyRateUsd: 22,
  status: 'active',
  tagline: 'Best city guide',
  bio: null,
  coverPhotoUrl: null,
  responseTimeH: 1,
  distanceKm: null,
  buddyLevel: null,
  meetupBaseLat: null,
  meetupBaseLng: null,
};

const PACKAGE = {
  id: 'pkg-3',
  buddyId: 'buddy-77',
  title: 'City Highlights',
  durationH: 3,
  maxGroup: 4,
  priceUsd: 75,
  category: 'city',
  description: 'See the best of the city in 3 hours.',
};

// NOTE: intentional stub — only getBuddyProfile and getBuddyBlockedDates are exercised.
jest.mock('../../../src/services/rentABuddy', () => ({
  getBuddyProfile: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      buddy: BUDDY,
      packages: [PACKAGE],
      addons: [],
      availability: [],
      reviews: [],
      savedByMe: false,
    },
  }),
  getBuddyBlockedDates: jest.fn().mockResolvedValue({
    ok: true,
    data: { blocked: [] },
  }),
  saveBuddy:   jest.fn().mockResolvedValue({ ok: true }),
  unsaveBuddy: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/reports', () => ({
  reportContent: jest.fn().mockResolvedValue({ ok: true }),
}));

// ── sub-components not under test ─────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives', () => ({
  TravelLoadingState: () => null,
  TravelErrorState:   () => null,
  TravelCard:         ({ children }: any) => children,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/interaction/UserOverflowMenu', () => ({
  UserOverflowMenu: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/location/MeetupAreaPreview', () => ({
  MeetupAreaPreview: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/awayDates', () => ({
  formatAwayRange:    () => '',
  upcomingAwayRanges: () => [],
}));
// NOTE: intentional stub — theme tokens are exhaustive; avoids native
// font/shadow resolution that crashes jest-expo.

import BuddyProfileScreen from '../buddy/[id]';

beforeEach(() => {
  routerPush.mockClear();
  mockSearchParams = { id: 'buddy-77' };
});

describe('buddy/[id].tsx — sticky Book Now button', () => {
  it('navigates to checkout with buddyId when "Book Now" is pressed', async () => {
    const { getByText } = await render(<BuddyProfileScreen />);
    await waitFor(() => getByText('Book Now'));

    fireEvent.press(getByText('Book Now'));

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: BUDDY.id }),
      }),
    );
  });

  it('"Book Now" does NOT navigate to request-buddy', async () => {
    const { getByText } = await render(<BuddyProfileScreen />);
    await waitFor(() => getByText('Book Now'));

    fireEvent.press(getByText('Book Now'));

    const wentToRequestBuddy = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && String(arg?.pathname ?? '').includes('request-buddy'),
    );
    expect(wentToRequestBuddy).toBe(false);
  });
});

describe('buddy/[id].tsx — PackageCard "Book This Package" button', () => {
  it('navigates to checkout with buddyId and packageId', async () => {
    const { getByText } = await render(<BuddyProfileScreen />);
    await waitFor(() => getByText('Book This Package'));

    fireEvent.press(getByText('Book This Package'));

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({
          buddyId:   BUDDY.id,
          packageId: PACKAGE.id,
        }),
      }),
    );
  });
});
