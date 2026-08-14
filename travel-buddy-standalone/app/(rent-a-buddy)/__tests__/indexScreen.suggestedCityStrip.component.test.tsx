/**
 * index.tsx (RentABuddyLanding) — suggested-city strip label correctness.
 *
 * When the viewer's city (Cebu) is live but has zero available buddies, the
 * launch-status API returns a `suggestedCity` ("Miami"). The component fetches
 * real buddies from Miami and surfaces them with an honest label.
 *
 * This test confirms the critical invariant:
 *   - The strip label names Miami, NOT Cebu.
 *   - The "See all Buddies in …" link also names Miami, NOT Cebu.
 *   - Pressing the link navigates to the Miami search page.
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

// ── expo-router ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — only router.push is asserted; navigation internals
// are not under test here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => false },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;

// ── safe-area ──────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── rentABuddy services ───────────────────────────────────────────────────────
const mockGetLaunchStatus = jest.fn();
const mockGetAvailableNow = jest.fn();
const mockSearchBuddies   = jest.fn();

// NOTE: intentional stub — only these three service functions are exercised.
jest.mock('../../../src/services/rentABuddy', () => ({
  getLaunchStatus: (...args: unknown[]) => mockGetLaunchStatus(...args),
  getAvailableNow: (...args: unknown[]) => mockGetAvailableNow(...args),
  searchBuddies:   (...args: unknown[]) => mockSearchBuddies(...args),
}));

// ── BuddyCard ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — card UI is irrelevant; only label text and link
// navigation are asserted on in these tests.
jest.mock('../../../src/components/BuddyCard', () => ({
  BuddyCard:         () => null,
  BuddyCardSkeleton: () => null,
}));

// ── GlobalPlacePicker — auto-fires onSelect("Cebu") on mount ──────────────────
// NOTE: intentional stub — fires onSelect with Cebu on mount so city state is
// populated when render() resolves, without any press interaction (preserves
// per-file press budget for the link-navigation test below).
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: ({ onSelect }: { onSelect: (place: any) => void }) => {
    const { useEffect } = require('react');
    useEffect(() => {
      onSelect({ city: 'Cebu', name: 'Cebu City', lat: 10.31, lng: 123.89 });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
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

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CEBU_LAUNCH_STATUS = {
  city:             'Cebu',
  status:           'public_mvp',
  message:          'Rent a Buddy is live in Cebu!',
  available:        true,
  availableNowCount: 0,
  betaAvailable:    false,
  waitlistOpen:     true,
  applicationsOpen: true,
  targetLaunchDate: null,
  suggestedCity:    'Miami',
  suggestedCityAvailableCount: 2,
};

const MIAMI_BUDDY = {
  id: 'miami-1', userId: 'u-miami-1', displayName: 'Carlos',
  city: 'Miami', country: 'US', categories: ['city'],
  languages: ['English', 'Spanish'], verified: true, averageRating: 4.8,
  reviewCount: 12, hourlyRateUsd: 35, status: 'active',
  tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 1, distanceKm: null, buddyLevel: null,
  meetupBaseLat: null, meetupBaseLng: null,
};

/**
 * Real sleep inside act — safe per the React 19 renderer budget rule:
 * no fake timers in component test files.
 */
async function sleepInAct(ms: number) {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RentABuddyLanding — suggested-city strip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    routerPush.mockClear();

    // Cebu: 0 available buddies; Miami: 1 available buddy.
    mockGetAvailableNow.mockImplementation((city: string) => {
      if (city === 'Miami') {
        return Promise.resolve({ ok: true, data: { buddies: [MIAMI_BUDDY] } });
      }
      // Cebu (and any other city): no buddies available.
      return Promise.resolve({ ok: true, data: { buddies: [] } });
    });

    mockGetLaunchStatus.mockResolvedValue({
      ok: true,
      data: CEBU_LAUNCH_STATUS,
    });

    mockSearchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0 } });
  });

  it('label names the suggested city (Miami) — never the viewer city (Cebu)', async () => {
    await render(<RentABuddyLanding />);

    // Drain the 700 ms getLaunchStatus debounce + all promise resolutions.
    await sleepInAct(1100);

    // Both the banner and the strip label mention "available in Miami" — use
    // getAllByText so the multi-element match doesn't throw.
    await waitFor(() => {
      expect(screen.getAllByText(/available in Miami/i).length).toBeGreaterThanOrEqual(1);
    });

    // No text node on screen may mention "available in Cebu" — that would
    // mislead a traveler into thinking buddies are local to their city.
    expect(screen.queryByText(/available in Cebu/i)).toBeNull();
  });

  it('"See all Buddies" link names Miami — never Cebu', async () => {
    await render(<RentABuddyLanding />);
    await sleepInAct(1100);

    await waitFor(() => {
      expect(screen.getByText('See all Buddies in Miami →')).toBeTruthy();
    });

    // Ensure there is no link pointing to Cebu.
    expect(screen.queryByText('See all Buddies in Cebu →')).toBeNull();
  });

  it('"See all Buddies in Miami →" navigates to the Miami search page', async () => {
    await render(<RentABuddyLanding />);
    await sleepInAct(1100);

    await waitFor(() => {
      expect(screen.getByText('See all Buddies in Miami →')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('See all Buddies in Miami →'));

    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(rent-a-buddy)/search',
        params:   expect.objectContaining({ city: 'Miami' }),
      }),
    );

    // Must NOT navigate to a Cebu search page.
    const wentToCebu = routerPush.mock.calls.some(([arg]: [any]) =>
      typeof arg === 'object' && arg?.params?.city === 'Cebu',
    );
    expect(wentToCebu).toBe(false);
  });
});
