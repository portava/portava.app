/**
 * census-layover L273 / L254 / L294 — THE WIRING HALF of the buddy list.
 *
 * `LayoverPeopleSection.buddiesTruth.component.test.tsx` proves the CARD can
 * tell a failed read, a safety-gate refusal and a measured list apart. This
 * file proves the SCREEN hands it the answer to do it with. The dashboard
 * used to store
 *
 *   setBuddies(buddyRes?.buddies ?? []);
 *
 * so a 503 or an offline device became an empty list, and the gate's refusal
 * — `reason: "safety_gate_not_passed"`, computed so that a traveller who
 * cannot leave is not handed people to go and meet — was dropped on the floor
 * with every other field the route publishes.
 *
 * `LayoverPeopleSection` is deliberately NOT stubbed: the point is the value
 * crossing the prop boundary.
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

// NOTE: intentional stub — expo-notifications needs a native runtime and this
// file is about a presence read, not about scheduling.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — each pulls maps, plan or compass chains that have
// nothing to do with the presence answer. LayoverPeopleSection is NOT here.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: () => <View testID="layover-hero-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null })); jest.mock('../../../src/components/layover/LayoverConstraintsCard', () => ({ LayoverConstraintsCard: () => null })); // NOTE: intentional stub — the card has its own suite (LayoverConstraintsCard.component.test.tsx)
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
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub — the screen only needs data to render here; the
// service's own parsing is exercised against a fetch spy in the card suites.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => (global as any).__buddies),
  getLayoverPresence: jest.fn(async () => (global as any).__presence),
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


/** Sharing is ON, so the screen calls `getLayoverPresence` and renders the box. */
function overviewBody() {
  return {
    session: {
      id: 'sess-1', userId: 'u-1', airportId: 'ap-1', tripId: null,
      arrivalTime: new Date(NOW - HOUR).toISOString(),
      departureTime: new Date(NOW + 6 * HOUR).toISOString(),
      boardingTime: null, layoverMinutes: 420, flightType: 'international',
      immigrationRequired: true, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: 'moderate', vibeChips: [],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
      canonicalCityId: null, shareCityStatus: true,
      returnReminderAt: null,
      status: 'active', createdAt: new Date(NOW - HOUR).toISOString(),
    },
    airport: {
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
      countryCode: 'TH', timezone: 'Asia/Bangkok', lat: 13.69, lng: 100.75, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 240,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState: 'NORMAL', tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 240, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    // `othersInCity` is the OVERVIEW's copy of the count. It is deliberately 0
    // here so that nothing in these cases can be satisfied by it instead of by
    // the presence read — see case 5, which sets it to 0 and still expects 3.
    share: { enabled: true, othersInCity: 0 },
    safeReturn: { returnState: 'NORMAL', hardReturnTime: HARD_RETURN, notification: null },
    safeEnvelope: null, offlineBundle: null,
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '12:00', airportToday: '2026-01-01',
      arrivalLocal: '11:00', arrivalDay: '2026-01-01',
      departureLocal: '18:00', departureDay: '2026-01-01',
    },
  };
}

async function mount(buddies: unknown) {
  (global as any).__overview = overviewBody();
  (global as any).__presence = null;
  (global as any).__buddies = buddies;
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
}

const BUDDY = {
  id: 'b-1', userId: 'u-9', displayName: 'Mai', tagline: null, city: 'Bangkok', country: 'Thailand',
  categories: ['city'], hourlyRateUsd: 20, averageRating: 4.8, reviewCount: 12, verified: true,
  coverPhotoUrl: null, buddyLevel: 'pro', availableNow: false, availableDuringLayover: true,
};

describe('the buddy answer reaches the card whole', () => {
  it('1. a FAILED read is shown as one — not as an empty marketplace', async () => {
    await mount({ ok: false, message: 'Local buddies could not be loaded. Please try again.' });
    await waitFor(() => expect(screen.getByTestId('layover-buddies-unavailable')).toBeTruthy());
  });

  it('2. the safety gate\'s refusal reaches the card', async () => {
    await mount({
      ok: true, city: 'Bangkok', buddies: [], refusal: 'safety_gate_not_passed',
      safetyGate: { passed: false, verdict: 'no', usableMinutes: 20, returnState: 'NORMAL' },
      trustRequirement: null, degraded: false, degradedReasons: [],
    });
    await waitFor(() => expect(screen.getByTestId('layover-buddies-gate')).toBeTruthy());
  });

  it('3. CONTROL: a measured list is rendered as a list', async () => {
    await mount({
      ok: true, city: 'Bangkok', buddies: [BUDDY], refusal: null,
      safetyGate: { passed: true, verdict: 'yes', usableMinutes: 240, returnState: 'NORMAL' },
      trustRequirement: { applied: false, reason: null, requires: [] },
      degraded: false, degradedReasons: [],
    });
    await waitFor(() => expect(screen.getByText('Mai')).toBeTruthy());
    expect(screen.queryByTestId('layover-buddies-unavailable')).toBeNull();
  });
});
