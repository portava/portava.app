/**
 * census-layover §16 L157 — THE WIRING HALF: the one loop this surface has is
 * state-dependent.
 *
 * `src/lib/__tests__/layoverSensingCadence.test.ts` proves the policy. This
 * file proves the SCREEN obeys it, which is the half that reaches a traveller:
 * the dashboard re-read `GET /overview` every 60 seconds whether the certified
 * rung was NORMAL or RETURN_NOW, so the numbers someone acts on while walking
 * back to an airport aged exactly as fast as the ones they read over lunch.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The two cases are the same screen, the same fixture and the same elapsed
 * time, differing only in the certified `returnState`. A screen that kept one
 * fixed interval — 60 s or 15 s, it does not matter which — fails one of them.
 * The NORMAL case is the regression guard in particular: this change tightens
 * the sharp end and must not quicken the cadence that already shipped.
 *
 * Timers are faked because the assertion is about ELAPSED TIME, and a real
 * 60-second wait in a suite is not a test anybody runs.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';
import { getLayoverOverview } from '../../../src/services/layover';

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

// NOTE: intentional stub — expo-notifications needs a native runtime and this
// file is about a polling interval, not about scheduling.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — every card below pulls maps, plan, crew or compass
// chains with nothing to do with the refresh cadence.
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
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverDiscoveryCard', () => ({ LayoverDiscoveryCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverSafeReturnCard', () => ({ LayoverSafeReturnCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverOfflinePlanCard', () => ({ LayoverOfflinePlanCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name, so a requireActual spread would drag `lib/supabase` and its
// native SecureStore adapter into the module graph.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__ovRead),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Istanbul', buddies: [] })),
  getLayoverPresence: jest.fn(async () => null),
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

function overviewBody(returnState: string) {
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
      id: 'ap-1', iataCode: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'Türkiye',
      countryCode: 'TR', timezone: 'Europe/Istanbul', lat: 41.2753, lng: 28.7519, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 240,
      earliestOutTime: new Date(NOW).toISOString(),
      hardReturnTime: new Date(NOW + 2 * HOUR).toISOString(),
      returnState, tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 240, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    safeReturn: {
      returnState, explorationCollapsed: false, returnRoutePrimary: false,
      minutesToHardReturn: 120, abortAvailable: true,
    },
    safeEnvelope: null,
    offlineBundle: null,
    returnReminderAt: null,
    localTimes: {
      timezone: 'Europe/Istanbul', airportNow: '12:00', airportToday: '2026-01-01',
      arrivalLocal: '11:00', arrivalDay: '2026-01-01',
      departureLocal: '18:00', departureDay: '2026-01-01',
    },
  };
}

const reads = getLayoverOverview as unknown as jest.Mock;

/**
 * Mount and let the initial load settle.
 *
 * `await render(...)` and the RETURNED queries, not the module-level `screen`:
 * under fake timers this workspace's React 19 + RNTL v14 pairing does not
 * record a synchronous `render()` into `screen` at all (probed directly — a
 * one-component fixture reproduces it), so `screen.getByTestId` answers
 * "`render` function has not been called" for a tree that is on screen.
 * `waitFor` is avoided for the same family of reason: it schedules its retries
 * on the faked clock.
 */
async function mountWith(returnState: string) {
  (global as any).__ovRead = { ok: true, overview: overviewBody(returnState) };
  const view = await render(<LayoverDashboardScreen />);
  await act(async () => {});
  await act(async () => {});
  // Proves the screen actually rendered rather than the flushes being enough.
  expect(view.getByTestId('layover-hero-stub')).toBeTruthy();
  return view;
}

/** Advance the fake clock inside act so the interval's async work settles. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  // Let the awaited read resolve before the assertion looks at the mock.
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  reads.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('§16 L157 — the overview re-read follows the certified rung', () => {
  it('at RETURN_NOW, 20 seconds is enough to re-read', async () => {
    await mountWith('RETURN_NOW');
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(20_000);
    // The sharp rung polls at 15 s, so one full period has passed.
    expect(reads.mock.calls.length).toBeGreaterThan(1);
  });

  it('at NORMAL, the same 20 seconds re-reads NOTHING', async () => {
    await mountWith('NORMAL');
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(20_000);
    // 60 s, exactly as this screen has always behaved.
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(45_000);
    expect(reads.mock.calls.length).toBeGreaterThan(1);
  });
});
