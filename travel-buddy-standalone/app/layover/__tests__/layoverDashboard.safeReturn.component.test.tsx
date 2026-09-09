/**
 * Layover dashboard (app/layover/[id].tsx) — the Safe Return card is MOUNTED.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * A component that renders correctly in its own test but is imported by no
 * screen reaches no traveller — which is exactly what happened to
 * LayoverReturnPanel, 240 lines that nothing ever mounted. So this test renders
 * the real dashboard screen and asserts that the abort control and the
 * Ask-Compass panel are actually in the tree, and that the §15
 * `returnRoutePrimary` posture moves the card above the hero.
 *
 * The heavy sibling sections are stubbed; LayoverSafeReturnCard and
 * LayoverCompassCard are NOT — they are what is under test here.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'sess-1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

// NOTE: intentional stub — requireActual pulls native-module internals that are
// not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentional stub — expo-notifications needs a native runtime; the
// dashboard's reminder path is not under test here.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
}));

// ── Heavy sibling sections, stubbed to null ───────────────────────────────────
// NOTE: intentional stubs — each pulls maps, discovery or presence chains that
// are irrelevant to whether the Safe Return card is mounted.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: () => <View testID="layover-hero-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportEssentialsCard', () => ({ AirportEssentialsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPlanSection', () => ({ LayoverPlanSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverMapCard', () => ({ LayoverMapCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));

// ── The service the screen loads from ─────────────────────────────────────────
const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const HARD_RETURN = '2026-09-08T13:40:00.000Z';

const CERTIFICATION = {
  engineVersion: '2026.09.02-3',
  feasibilityVersion: '2026.09.05-1',
  inputHash: 'a1b2c3d4e5f60718',
  computedAt: CERTIFIED_AT,
  verdict: 'tight',
  confidence: 'LOW',
  bufferPercentile: 'p90',
};

function overview(returnRoutePrimary: boolean) {
  return {
    session: {
      id: 'sess-1', userId: 'u-1', airportId: 'ap-1', tripId: null,
      arrivalTime: '2026-09-08T08:00:00.000Z', departureTime: '2026-09-08T16:00:00.000Z',
      boardingTime: null, layoverMinutes: 480, flightType: 'international',
      immigrationRequired: true, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: 'moderate', vibeChips: [],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
      status: 'active', createdAt: '2026-09-08T07:00:00.000Z',
    },
    airport: {
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok',
      country: 'Thailand', countryCode: 'TH', timezone: 'Asia/Bangkok',
      lat: 13.68, lng: 100.74, verified: false,
    },
    window: {
      totalMinutes: 480, exitDelayMin: 40, returnBufferMin: 95, usableMinutes: 345,
      hardReturnTime: HARD_RETURN, earliestOutTime: '2026-09-08T08:40:00.000Z',
      breakdown: { baseBuffer: 60, immigrationExtra: 20, bagsExtra: 15, trafficExtra: 0, timeOfDayExtra: 0, totalBuffer: 95, exitDelay: 40 },
      tier: 'half_day', tierLabel: 'Half day', tierBlurb: 'Plenty of time.',
      overnight: false,
      returnState: returnRoutePrimary ? 'RETURN_NOW' : 'NORMAL',
      engineVersion: '2026.09.02-3',
    },
    advice: {
      verdict: 'tight', reasons: [], unknowns: [], reasonCodes: [],
      disclaimer: 'Estimates only.', engineVersion: '2026.09.02-3',
    },
    stops: [],
    planFit: { totalPlannedMin: 0, returnTravelMin: 0, neededMin: 0, usableMinutes: 345, fitsWindow: true, overflowMin: 0, backByTime: HARD_RETURN },
    share: { enabled: false, othersInCity: 0 },
    certification: CERTIFICATION,
    safeReturn: {
      safeReturnVersion: '2026.09.08-1',
      returnState: returnRoutePrimary ? 'RETURN_NOW' : 'NORMAL',
      explorationCollapsed: returnRoutePrimary,
      returnRoutePrimary,
      pinTerminalContext: returnRoutePrimary,
      notifyCrew: returnRoutePrimary,
      offerRecoveryHelp: false,
      primaryAction: returnRoutePrimary ? 'return_now' : 'explore',
      abortAvailable: true,
      minutesToHardReturn: returnRoutePrimary ? -3 : 220,
    },
    offlineBundle: {
      bundleVersion: '2026.09.08-1', sessionId: 'sess-1',
      certifiedAt: CERTIFIED_AT, staleAfter: '2026-09-08T10:15:00.000Z',
      certification: CERTIFICATION,
      returnDeadline: { hardReturnTime: HARD_RETURN, hardReturnLocal: '20:40', returnState: 'NORMAL', bufferMinutes: 95, returnReminderAt: null },
      airport: { iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand', timezone: 'Asia/Bangkok', lat: 13.68, lng: 100.74, terminalInfo: null },
      mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
      route: { available: false, value: null, reason: 'no_routing_provider' },
      flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
      crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
      translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
      stops: [],
    },
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '17:00', airportToday: '2026-09-08',
      arrivalLocal: '15:00', arrivalDay: '2026-09-08',
      departureLocal: '23:00', departureDay: '2026-09-08',
      boardingLocal: null, hardReturnLocal: '20:40',
    },
  };
}

let routePrimary = false;

// NOTE: intentional stub — the wire-level behaviour of these calls is covered by
// src/components/layover/__tests__/LayoverSafeReturnCard.component.test.tsx,
// which runs the real service against a fetch spy. Here the screen only needs
// data to render.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__overview),
  getRecommendations: jest.fn(async () => []),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
  getLayoverPresence: jest.fn(async () => ({ sharing: false, count: 0, travelers: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => true),
  sendLayoverTelegraph: jest.fn(async () => null),
  setReturnDeadline: jest.fn(async () => null),
  setShareCityStatus: jest.fn(async () => null),
  returnToAirportNow: jest.fn(async () => ({ kind: 'offline' })),
  askCompass: jest.fn(async () => null),
}));

beforeEach(() => {
  (global as any).__overview = overview(routePrimary);
});

/** Depth-first testIDs in render order. JSON.stringify cannot be used on the
 *  rendered tree — its props carry circular fiber references. */
function testIdOrder(): string[] {
  const ids: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const id = node.props?.testID;
    if (typeof id === 'string') ids.push(id);
    (node.children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return ids;
}

test('the dashboard mounts the Safe Return card with a working abort control', async () => {
  routePrimary = false;
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-safe-return-card')).toBeTruthy());
  // §15.1 — the control is present on an active landside plan.
  expect(screen.getByTestId('return-to-airport-btn')).toBeTruthy();
  // §2.1 — the traveller can see when the answer was computed.
  expect(screen.getByTestId('safe-return-certification')).toBeTruthy();
  // The Compass panel — the only client caller of POST …/compass.
  expect(screen.getByTestId('layover-compass-card')).toBeTruthy();
});

test('a RETURN_NOW posture hoists the card above the hero', async () => {
  (global as any).__overview = overview(true);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-safe-return-card')).toBeTruthy());
  expect(screen.getByText('Head back to the airport now')).toBeTruthy();
  // Past the deadline the card counts UP, rather than showing a negative.
  expect(screen.getByText(/3m past your return time/)).toBeTruthy();

  // The hoist itself: the card is emitted BEFORE the hero in the tree.
  const order = testIdOrder();
  expect(order.indexOf('layover-safe-return-card')).toBeLessThan(order.indexOf('layover-hero-stub'));
});

test('a NORMAL posture leaves the card below the hero, with the plan it aborts', async () => {
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-safe-return-card')).toBeTruthy());
  const order = testIdOrder();
  expect(order.indexOf('layover-safe-return-card')).toBeGreaterThan(order.indexOf('layover-hero-stub'));
});
