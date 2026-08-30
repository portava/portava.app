/**
 * index.tsx (RentABuddyLanding) — Available Now and Top Buddies strips checkout routing.
 *
 * Verifies that both BuddyCard strips pass an `onBook` callback that navigates
 * to `/(rent-a-buddy)/checkout` — not to the old `request-buddy` form.
 *
 * Strategy: stub GlobalPlacePicker to immediately call `onSelect` with a city,
 * which sets the city state → triggers getAvailableNow → renders BuddyCard.
 * We also stub BuddyCard to capture the `onBook` prop so we can call it and
 * assert the router.push destination without pressing through BuddyCard internals.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

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
const AVAILABLE_BUDDY = {
  id: 'avail-1', userId: 'user-avail-1', displayName: 'Ana',
  city: 'Lisbon', country: 'Portugal', categories: ['city'],
  languages: ['English'], verified: true, averageRating: 4.7,
  reviewCount: 8, hourlyRateUsd: 20, status: 'active',
  tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 1, distanceKm: null, buddyLevel: null,
  meetupBaseLat: null, meetupBaseLng: null,
};
const TOP_BUDDY = {
  id: 'top-1', userId: 'user-top-1', displayName: 'Luca',
  city: 'Lisbon', country: 'Portugal', categories: ['food'],
  languages: ['English', 'Italian'], verified: true, averageRating: 4.9,
  reviewCount: 45, hourlyRateUsd: 30, status: 'active',
  tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 2, distanceKm: null, buddyLevel: null,
  meetupBaseLat: null, meetupBaseLng: null,
};

// NOTE: intentional stub — only getAvailableNow, searchBuddies, getLaunchStatus are exercised.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({
    ok: true,
    data: { buddies: [AVAILABLE_BUDDY] },
  }),
  searchBuddies: jest.fn().mockResolvedValue({
    ok: true,
    data: { buddies: [TOP_BUDDY], total: 1 },
  }),
  getLaunchStatus: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── BuddyCard — prop-capture stub ─────────────────────────────────────────────
// NOTE: intentional stub — we capture onBook from each rendered BuddyCard
// to verify the destination without pressing through BuddyCard's internals.
const capturedOnBook: Record<string, (() => void) | undefined> = {};
jest.mock('../../../src/components/BuddyCard', () => ({
  BuddyCard: ({ buddy, onBook }: { buddy: { id: string }; onBook?: () => void }) => {
    capturedOnBook[buddy.id] = onBook;
    return null;
  },
  BuddyCardSkeleton: () => null,
}));

// ── GlobalPlacePicker — immediately selects a city to set component state ─────
// NOTE: intentional stub — calls onSelect on mount so city state is set,
// enabling the getAvailableNow effect and the BuddyCard strips to render.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: ({ onSelect }: { onSelect?: (place: any) => void }) => {
    require('react').useEffect(() => {
      onSelect?.({ city: 'Lisbon', name: 'Lisbon', lat: 38.7, lng: -9.1 });
    }, []);
    return null;
  },
}));

// ── other components not under test ───────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives', () => ({
  TravelSectionHeader:   ({ children }: any) => children ?? null,
  HorizontalScrollStrip: ({ children }: any) => children ?? null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));
// NOTE: intentional stub — theme tokens are exhaustive; avoids native
// font/shadow resolution that crashes jest-expo.

import RentABuddyLanding from '../index';

beforeEach(() => {
  routerPush.mockClear();
  delete capturedOnBook['avail-1'];
  delete capturedOnBook['top-1'];
});

describe('index.tsx — Available Now strip', () => {
  it('Available Now BuddyCard.onBook navigates to checkout with buddyId', async () => {
    await render(<RentABuddyLanding />);
    // Flush onSelect useEffect → city state update → getAvailableNow promise
    await act(async () => {});
    await act(async () => {});

    expect(capturedOnBook['avail-1']).toBeDefined();
    capturedOnBook['avail-1']!();

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/checkout',
        params: expect.objectContaining({ buddyId: 'avail-1' }),
      }),
    );
  });

  it('Available Now onBook does NOT navigate to request-buddy', async () => {
    await render(<RentABuddyLanding />);
    await act(async () => {});
    await act(async () => {});

    capturedOnBook['avail-1']?.();

    const wentToRequestBuddy = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && String(arg?.pathname ?? '').includes('request-buddy'),
    );
    expect(wentToRequestBuddy).toBe(false);
  });
});

describe('index.tsx — Top Buddies in City strip', () => {
  it('Top Buddies BuddyCard.onBook navigates to checkout with buddyId', async () => {
    // loadTopBuddies is reached ONLY through a 600 ms debounce (index.tsx:278).
    // With real timers it never fires within the test, so the Top Buddies strip
    // never renders and the old test fell through to `expect(true).toBe(true)`.
    // Drive the debounce with fake timers so the strip actually mounts and we
    // assert the real onBook destination (mirrors the Available Now test above).
    jest.useFakeTimers();
    try {
      await render(<RentABuddyLanding />);
      // onSelect useEffect → city state → schedules the 600 ms debounce timer
      await act(async () => {});
      // fire the debounce → loadTopBuddies → searchBuddies (mocked) begins
      await act(async () => { jest.advanceTimersByTime(600); });
      // flush the searchBuddies promise → setTopBuddies → strip renders BuddyCard
      await act(async () => {});

      expect(capturedOnBook['top-1']).toBeDefined();
      capturedOnBook['top-1']!();

      expect(routerPush).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/(rent-a-buddy)/checkout',
          params: expect.objectContaining({ buddyId: 'top-1' }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
