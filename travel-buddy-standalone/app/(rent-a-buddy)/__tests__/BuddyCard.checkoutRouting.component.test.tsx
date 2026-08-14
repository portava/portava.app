/**
 * BuddyCard — Book button routing tests.
 *
 * Verifies that:
 *   1. When an `onBook` callback is provided the Book button invokes it
 *      (callers own the destination — all entry-points wire to checkout).
 *   2. When `onBook` is omitted the internal fallback also navigates to checkout
 *      with `buddyId` set — not to the old request-buddy form.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — expo-router is mocked so we can assert on router.push.
// router.push uses jest.fn() inline so there is no hoisting issue.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
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

// ── rentABuddy services ───────────────────────────────────────────────────────
// NOTE: intentional stub — save/unsave side-effects are not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  saveBuddy:   jest.fn().mockResolvedValue({ ok: true }),
  unsaveBuddy: jest.fn().mockResolvedValue({ ok: true }),
}));

// ── sub-components not under test ─────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassFeedbackMenu', () => ({
  CompassFeedbackMenu: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassWhySheet', () => ({
  CompassWhySheet: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — theme tokens are exhaustive; this avoids native
// font/shadow resolution that would crash jest-expo.

import { BuddyCard } from '../../../src/components/BuddyCard';
import type { BuddyProfile } from '../../../src/services/rentABuddy';

const BUDDY: BuddyProfile = {
  id: 'buddy-42',
  userId: 'user-42',
  displayName: 'Maria',
  city: 'Barcelona',
  country: 'Spain',
  categories: ['city'],
  languages: ['English', 'Spanish'],
  verified: true,
  averageRating: 4.8,
  reviewCount: 12,
  hourlyRateUsd: 25,
  status: 'active',
  tagline: null,
  bio: null,
  coverPhotoUrl: null,
  responseTimeH: 1,
  distanceKm: null,
  buddyLevel: null,
  meetupBaseLat: null,
  meetupBaseLng: null,
};

beforeEach(() => {
  routerPush.mockClear();
});

describe('BuddyCard — Book button with onBook prop', () => {
  it('calls the onBook callback when Book is pressed', async () => {
    const onBook = jest.fn();
    const { getByText } = await render(
      <BuddyCard buddy={BUDDY} onBook={onBook} />,
    );
    await act(async () => {});

    fireEvent.press(getByText('Book'));
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  it('does NOT call router.push directly when onBook is provided', async () => {
    const onBook = jest.fn();
    const { getByText } = await render(
      <BuddyCard buddy={BUDDY} onBook={onBook} />,
    );
    await act(async () => {});

    fireEvent.press(getByText('Book'));
    expect(routerPush).not.toHaveBeenCalled();
  });
});

describe('BuddyCard — Book button fallback (no onBook prop)', () => {
  it('navigates to checkout with buddyId even when no onBook is provided', async () => {
    const { getByText } = await render(<BuddyCard buddy={BUDDY} />);
    await act(async () => {});

    fireEvent.press(getByText('Book'));
    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: expect.stringContaining('checkout'),
        params: expect.objectContaining({ buddyId: BUDDY.id }),
      }),
    );
  });

  it('fallback does NOT navigate to request-buddy', async () => {
    const { getByText } = await render(<BuddyCard buddy={BUDDY} />);
    await act(async () => {});

    fireEvent.press(getByText('Book'));
    const wentToRequestBuddy = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && String(arg?.pathname ?? '').includes('request-buddy'),
    );
    expect(wentToRequestBuddy).toBe(false);
  });
});
