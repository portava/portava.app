/**
 * saved.tsx — "Book again" and "Custom" buttons checkout routing tests.
 *
 * Verifies that both action buttons on a saved buddy row navigate to
 * `/(rent-a-buddy)/checkout` with the correct `buddyId` param — not to the
 * old request-buddy form.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — expo-router is mocked so we can assert on router.push.
// router.push uses jest.fn() inline so there is no hoisting issue.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => false },
  useLocalSearchParams: () => ({}),
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
const mockGetMySavedBuddies = jest.fn();
// NOTE: intentional stub — only getMySavedBuddies and unsaveBuddy are exercised here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getMySavedBuddies: (...args: unknown[]) => mockGetMySavedBuddies(...args),
  unsaveBuddy: jest.fn().mockResolvedValue({ ok: true }),
}));

// ── ui primitives not under test ──────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives', () => ({
  TravelEmptyState:   () => null,
  TravelErrorState:   () => null,
  TravelLoadingState: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — theme tokens are exhaustive; avoids native
// font/shadow resolution that crashes jest-expo.

import RentABuddySaved from '../saved';

const SAVED_BUDDY = {
  id: 'buddy-99',
  userId: 'user-99',
  displayName: 'Kenji',
  city: 'Tokyo',
  country: 'Japan',
  categories: ['city', 'food'],
  languages: ['English', 'Japanese'],
  verified: true,
  averageRating: 4.9,
  reviewCount: 30,
  hourlyRateUsd: 35,
  status: 'active',
  tagline: null,
  bio: null,
  coverPhotoUrl: null,
  responseTimeH: 2,
  distanceKm: null,
  buddyLevel: null,
  meetupBaseLat: null,
  meetupBaseLng: null,
};

beforeEach(() => {
  routerPush.mockClear();
  mockGetMySavedBuddies.mockResolvedValue({
    ok: true,
    data: { saved: [SAVED_BUDDY] },
  });
});

describe('saved.tsx — Book again button', () => {
  it('navigates to checkout with buddyId when "Book again" is pressed', async () => {
    const { getByText } = await render(<RentABuddySaved />);
    await waitFor(() => getByText('Book again'));

    fireEvent.press(getByText('Book again'));

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: SAVED_BUDDY.id }),
      }),
    );
  });
});

describe('saved.tsx — Custom button', () => {
  it('navigates to checkout with buddyId when "Custom" is pressed', async () => {
    const { getByText } = await render(<RentABuddySaved />);
    await waitFor(() => getByText('Custom'));

    fireEvent.press(getByText('Custom'));

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: SAVED_BUDDY.id }),
      }),
    );
  });
});
