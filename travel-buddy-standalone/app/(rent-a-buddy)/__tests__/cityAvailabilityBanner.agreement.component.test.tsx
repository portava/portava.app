/**
 * CityAvailabilityBanner — availability-agreement component tests.
 *
 * Renders `RentABuddyLanding` and drives city state via a `GlobalPlacePicker`
 * mock that auto-fires `onSelect("Cebu")` on mount. React's act() (inside
 * `await render(...)`) flushes the useEffect + resulting state updates, so
 * city = 'Cebu' and getAvailableNow have both resolved before the render
 * call returns. A real 1100 ms sleep then drains the 700 ms debounce inside
 * `CityAvailabilityBanner` plus getLaunchStatus resolution (no fake timers —
 * per the React 19 renderer budget rule).
 *
 * Confirms the critical fix:
 *   - public_mvp + zero available buddies → amber "no buddies" text,
 *     NOT a green "Rent a Buddy is live" banner
 *   - public_mvp + one available buddy    → green "live" text, no amber
 *   - Available Now empty-state text agrees with the amber banner (both
 *     surfaces reflect the same zero count, so they never contradict each other)
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── expo-router ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — navigation is not exercised; only banner and
// Available Now section text are asserted on in these tests.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(), back: jest.fn(), replace: jest.fn(), setParams: jest.fn(), canGoBack: () => false,
  },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

// ── safe-area ──────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockSetSessionLocation = jest.fn();
// NOTE: intentional exhaustive stub — this screen only reads setSessionLocation.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({ setSessionLocation: mockSetSessionLocation }),
}));

// ── rentABuddy services ───────────────────────────────────────────────────────
const mockGetLaunchStatus = jest.fn();
const mockGetAvailableNow = jest.fn();
const mockSearchBuddies   = jest.fn();

// NOTE: intentional stub — only these three service calls are exercised.
jest.mock('../../../src/services/rentABuddy', () => ({
  getLaunchStatus: (...args: unknown[]) => mockGetLaunchStatus(...args),
  getAvailableNow: (...args: unknown[]) => mockGetAvailableNow(...args),
  searchBuddies:   (...args: unknown[]) => mockSearchBuddies(...args),
}));

// ── BuddyCard ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — card UI is irrelevant; only banner text and the
// Available Now empty-state label are asserted on.
jest.mock('../../../src/components/BuddyCard', () => ({
  BuddyCard:         () => null,
  BuddyCardSkeleton: () => null,
}));

// ── GlobalPlacePicker — auto-fires onSelect("Cebu") on mount ─────────────────
// NOTE: intentional stub — auto-fires onSelect with Cebu on mount inside
// React's act() context so city state is already populated when render()
// resolves, without any press interaction (preserves per-file press budget).
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: ({ onSelect }: { onSelect: (place: any) => void }) => {
    const { useEffect } = require('react');
    useEffect(() => {
      onSelect({ city: 'Cebu', name: 'Cebu City', lat: 10.31, lng: 123.89 });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  },
}));

import RentABuddyLanding from '../index';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PUBLIC_MVP_BASE = {
  city:             'Cebu',
  status:           'public_mvp',
  message:          'Rent a Buddy is live in Cebu!',
  available:        true,
  betaAvailable:    false,
  waitlistOpen:     true,
  applicationsOpen: true,
  targetLaunchDate: null,
};

const ACTIVE_BUDDY = {
  id: 'buddy-1', userId: 'u-1', displayName: 'Maria',
  city: 'Cebu', country: 'PH', categories: ['city'],
  languages: ['English'], verified: true, averageRating: 4.7,
  reviewCount: 5, hourlyRateUsd: 20, status: 'active',
  tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 1, distanceKm: null, buddyLevel: null,
  meetupBaseLat: null, meetupBaseLng: null,
};

/**
 * Real sleep inside act — safe per the React 19 renderer budget rule:
 * "No fake timers in component files, ever."
 */
async function sleepInAct(ms: number) {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CityAvailabilityBanner — rendered availability agreement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0 } });
  });

  it('shows amber "no buddies right now" for public_mvp city with zero available buddies', async () => {
    // Zero online buddies: getAvailableNow → [] ; launch-status → availableNowCount: 0.
    // The banner must NOT show the green "live" message — it must show the
    // amber "no buddies are online right now" override instead.
    mockGetAvailableNow.mockResolvedValue({ ok: true, data: { buddies: [] } });
    mockGetLaunchStatus.mockResolvedValue({
      ok: true,
      data: { ...PUBLIC_MVP_BASE, availableNowCount: 0 },
    });

    // render() auto-fires GlobalPlacePicker.onSelect → city = 'Cebu';
    // act() inside render flushes the resulting effects + promise resolutions.
    await render(<RentABuddyLanding />);

    // Wait through the 700 ms debounce + getLaunchStatus promise resolution.
    await sleepInAct(1100);

    // Amber "no buddies" copy must be visible.
    await waitFor(() => {
      expect(screen.getByText(/no buddies are online right now/i)).toBeTruthy();
    });

    // Green "live" message must NOT appear.
    expect(screen.queryByText('Rent a Buddy is live in Cebu!')).toBeNull();
  });

  it('shows green "live" message for public_mvp city with at least one available buddy', async () => {
    // One online buddy: getAvailableNow → [ACTIVE_BUDDY]; launch-status → availableNowCount: 1.
    // The banner must show the original green "live" message from statusToMessage,
    // NOT the amber override.
    mockGetAvailableNow.mockResolvedValue({ ok: true, data: { buddies: [ACTIVE_BUDDY] } });
    mockGetLaunchStatus.mockResolvedValue({
      ok: true,
      data: { ...PUBLIC_MVP_BASE, availableNowCount: 1 },
    });

    await render(<RentABuddyLanding />);
    await sleepInAct(1100);

    // Green "live" message from statusToMessage appears.
    await waitFor(() => {
      expect(screen.getByText('Rent a Buddy is live in Cebu!')).toBeTruthy();
    });

    // Amber override must NOT be present.
    expect(screen.queryByText(/no buddies are online right now/i)).toBeNull();
  });

  it('shows green banner for public_mvp city where launch-status reports 10 available buddies even when the Available Now list is capped at 6', async () => {
    // Scenario: 10 buddies are online but getAvailableNow returns only 6 items
    // (the list is sliced to 6 in the component). The banner must use
    // info.availableNowCount (10) not availableNow.length (6 or 0) — both are
    // > 0 so the branch is the same here, but this guards against a future
    // regression where the banner re-derives count from the sliced list.
    //
    // To make the divergence conclusive we return an empty list from
    // getAvailableNow (simulating a failed list call) while launch-status
    // still reports 10 online.  Old prop-based code would read
    // availableNow.length = 0 → amber; new code reads info.availableNowCount
    // = 10 → green.
    mockGetAvailableNow.mockResolvedValue({ ok: true, data: { buddies: [] } });
    mockGetLaunchStatus.mockResolvedValue({
      ok: true,
      data: { ...PUBLIC_MVP_BASE, availableNowCount: 10 },
    });

    await render(<RentABuddyLanding />);
    await sleepInAct(1100);

    // Banner must show the green "live" message — 10 buddies online.
    await waitFor(() => {
      expect(screen.getByText('Rent a Buddy is live in Cebu!')).toBeTruthy();
    });

    // Amber "no buddies" override must NOT appear (count is 10, not 0).
    expect(screen.queryByText(/no buddies are online right now/i)).toBeNull();
  });

  it('Available Now empty-state text agrees with the zero-buddy amber banner', async () => {
    // Both the Available Now section AND the banner must report zero buddies —
    // they must never show contradictory messages on the same screen.
    mockGetAvailableNow.mockResolvedValue({ ok: true, data: { buddies: [] } });
    mockGetLaunchStatus.mockResolvedValue({
      ok: true,
      data: { ...PUBLIC_MVP_BASE, availableNowCount: 0 },
    });

    await render(<RentABuddyLanding />);
    await sleepInAct(1100);

    // Available Now section shows the "check back soon" empty state.
    await waitFor(() => {
      expect(screen.getByText(/No Buddies available right now in Cebu/i)).toBeTruthy();
    });

    // Banner also shows amber — both surfaces agree there are no buddies.
    expect(screen.getByText(/no buddies are online right now/i)).toBeTruthy();
    // Green "live" message absent from both surfaces.
    expect(screen.queryByText('Rent a Buddy is live in Cebu!')).toBeNull();
  });
});
