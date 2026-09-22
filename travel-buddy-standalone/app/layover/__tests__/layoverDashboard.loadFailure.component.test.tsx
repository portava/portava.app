/**
 * census-layover L156 / L294 — "IT MAY HAVE BEEN REMOVED, OR YOU'RE OFFLINE."
 *
 * §16 L156 asks for a degraded mode that shows "unavailable/stale" rather than
 * guessing, and the census's own row records the client half of the gap:
 *
 *   > Offline, `getLayoverOverview` returns null and the screen renders a
 *   > generic failure with no distinction between "removed" and "offline" —
 *   > the copy says both.
 *
 * Two things were wrong, and the second is worse than the row records.
 *
 * ONE — THE SERVER ALREADY DISTINGUISHES THEM AND THE CLIENT THREW IT AWAY.
 * `ownedSessionOr` (`artifacts/api-server/src/routes/airport.ts:1869`) refuses
 * with `not_found` / "Session not found" when the session is gone or is not
 * yours, and with `degraded_unavailable` / "Your layover could not be loaded.
 * Please try again." + `retryable: true` when a read failed. The parsing half
 * of this is `src/components/layover/__tests__/layoverOverviewRead...`.
 *
 * TWO — OFFLINE NEVER REACHED THAT SCREEN AT ALL. `load()` had no `try`, and
 * `authedFetch` REJECTS when the device has no network. The rejection escaped
 * `Promise.all`, `setLoading(false)` never ran, and the dashboard sat on
 * "Loading your layover…" indefinitely with an unhandled promise rejection
 * behind it. The census row describes copy; the tree showed no copy at all.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 1 makes the mocked service REJECT — the exact shape of being offline —
 * and asserts the spinner is gone. The old screen could not satisfy that no
 * matter what its copy said, and a screen that catches but keeps `loading`
 * true still fails it. Case 4 is the control: a good read must still render.
 *
 * NO PINNED DATES: every instant is derived from `Date.now()` at module load.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';

// NOTE: intentional stub — requireActual pulls native-module internals that are
// not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'sess-1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

// NOTE: intentional stub — expo-notifications needs a native runtime.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — each pulls maps, plan, compass or crew chains that
// have nothing to do with how a FAILED overview read is reported.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: () => <View testID="layover-hero-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportEssentialsCard', () => ({ AirportEssentialsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportConditionsCard', () => ({ AirportConditionsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPlanSection', () => ({ LayoverPlanSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverMapCard', () => ({ LayoverMapCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub — `__ovImpl` is set per case so one module mock can
// RESOLVE a refusal in some cases and REJECT outright in others. A rejection is
// what being offline looks like to this screen, and it has to be reachable.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__ovImpl()),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
  getLayoverPresence: jest.fn(async () => null),
  // census L269 — the screen mounts LayoverDiscoveryCard, which reads through
  // this module. Kept in step with the exhaustive list above: an omission here
  // does not fail as a missing card, it throws inside the render.
  getLayoverDiscovery: jest.fn(async () => ({ ok: true, gems: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => ({ ok: true, outcome: 'cancelled', passportStamp: null })),
  sendLayoverTelegraph: jest.fn(async () => null),
  setReturnDeadline: jest.fn(async () => null),
  setShareCityStatus: jest.fn(async () => null),
  returnToAirportNow: jest.fn(async () => ({ kind: 'offline' })),
  askCompass: jest.fn(async () => null),
  getAirportObservations: jest.fn(async () => null),
  submitAirportObservation: jest.fn(async () => ({ ok: false, message: 'stub', rateLimited: false })),
  getLayoverCrew: jest.fn(async () => null),
  createLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  joinLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  leaveLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  updateLayoverSession: jest.fn(async () => null),
}));

const HOUR = 3_600_000;
const NOW = Date.now();
const HARD_RETURN = new Date(NOW + 4 * HOUR).toISOString();

const GONE = /may have been removed|no longer exists|not found/i;
const LOADING = /Loading your layover/i;

function goodOverview() {
  return {
    session: {
      id: 'sess-1', userId: 'u-1', airportId: 'ap-1', tripId: null,
      arrivalTime: new Date(NOW - HOUR).toISOString(),
      departureTime: new Date(NOW + 6 * HOUR).toISOString(),
      boardingTime: null, layoverMinutes: 420, flightType: 'international',
      immigrationRequired: true, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: 'moderate', vibeChips: [],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
      status: 'active', createdAt: new Date(NOW - HOUR).toISOString(),
    },
    airport: {
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok',
      country: 'Thailand', countryCode: 'TH', timezone: 'Asia/Bangkok',
      lat: 13.69, lng: 100.75, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 240,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState: 'NORMAL', tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: null, estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 240, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    safeReturn: { returnState: 'NORMAL', hardReturnTime: HARD_RETURN, notification: null },
    safeEnvelope: null, offlineBundle: null, returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '12:00', airportToday: '2026-01-01',
      arrivalLocal: '11:00', arrivalDay: '2026-01-01',
      departureLocal: '18:00', departureDay: '2026-01-01',
    },
  };
}

async function mount(impl: () => unknown) {
  (global as any).__ovImpl = impl;
  await render(<LayoverDashboardScreen />);
}

describe('a failed overview read says which failure it is, and always stops loading', () => {
  it('1. a REJECTED read (offline) leaves the spinner — it used to hang there forever', async () => {
    await mount(() => { throw new TypeError('Network request failed'); });

    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    expect(screen.queryByText(LOADING)).toBeNull();
    // Being offline is not a deletion. Never guess that the layover is gone.
    expect(screen.queryByText(GONE)).toBeNull();
    expect(screen.getByTestId('layover-load-retry')).toBeTruthy();
  });

  it('2. a 404 says the layover is gone, and offers no retry', async () => {
    await mount(() => ({
      ok: false, reason: 'gone', message: 'Session not found', retryable: false,
    }));

    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    expect(screen.getByText(GONE)).toBeTruthy();
    expect(screen.queryByTestId('layover-load-retry')).toBeNull();
  });

  it('3. a 503 offers the retry and does NOT suggest the layover was removed', async () => {
    await mount(() => ({
      ok: false, reason: 'unavailable',
      message: 'Your layover could not be loaded. Please try again.',
      retryable: true,
    }));

    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    // The server wrote a sentence for this case; the screen must use it.
    expect(screen.getByText('Your layover could not be loaded. Please try again.')).toBeTruthy();
    expect(screen.queryByText(GONE)).toBeNull();
    expect(screen.getByTestId('layover-load-retry')).toBeTruthy();
  });

  it('4. a successful read still renders the dashboard', async () => {
    await mount(() => ({ ok: true, overview: goodOverview() }));

    await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
    expect(screen.queryByTestId('layover-load-error')).toBeNull();
    expect(screen.queryByText(LOADING)).toBeNull();
  });
});
