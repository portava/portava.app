/**
 * census-layover L127 / L128 / L294 — THE WIRING HALF.
 *
 * `LayoverPeopleSection.presenceTruth.component.test.tsx` proves the CARD can
 * tell a refusal from a measured zero. This file proves the SCREEN hands it the
 * fields to do it with, which is where the defect actually lived:
 *
 *   const res = await getLayoverPresence(sessionId);
 *   if (res?.sharing) setPresence({ count: res.count, travelers: res.travelers });
 *   else setPresence({ count: 0, travelers: [] });
 *
 * Three server answers collapsed into `{ count: 0, travelers: [] }` there:
 *   - `null`      — the HTTP read itself failed (503 `degraded_unavailable`,
 *                   or `fetch` rejected because the device is offline)
 *   - `degraded`  — the route answered, and said its count is not a measurement
 *   - `withheld`  — the gate refused on the traveller's own stored settings
 *
 * and the card then printed "No other shared layovers here right now — you're
 * the first." for all three. A traveller in ghost mode, and a traveller during
 * a Supabase outage, were both told the city was empty.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 4 is the control: a genuinely measured zero must still produce the
 * claim, so a fix that simply stops the screen from ever asserting anything
 * fails here. Case 5 keeps the real count rendering.
 *
 * `LayoverPeopleSection` is deliberately NOT stubbed in this file — the point
 * is the value crossing the prop boundary, and a stub would assert nothing.
 *
 * NO PINNED DATES. Every instant is derived from `Date.now()` at module load,
 * so nothing here expires.
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
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub — the screen only needs data to render here; the
// service's own parsing is exercised against a fetch spy in the card suites.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
  getLayoverPresence: jest.fn(async () => (global as any).__presence),
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

const FIRST = /you're the first/i;

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

async function mount(presence: unknown) {
  (global as any).__overview = overviewBody();
  (global as any).__presence = presence;
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
}

describe('the presence read reaches the card with its confidence intact', () => {
  it('1. a null read (503 / offline) is NOT rendered as an empty city', async () => {
    await mount(null);
    await waitFor(() => expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy());
    expect(screen.queryByText(FIRST)).toBeNull();
  });

  it('2. a degraded answer is NOT rendered as an empty city', async () => {
    await mount({
      sharing: true, city: 'Bangkok', count: 0, travelers: [],
      level: 'L2_DISCOVERY', degraded: true, degradedReasons: ['presence_unreadable'],
    });
    await waitFor(() => expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy());
    expect(screen.queryByText(FIRST)).toBeNull();
  });

  it('3. a gate refusal on the traveller\'s own settings is named, not hidden', async () => {
    // The route's non-opted-in / gate-refused branch: `sharing: false` with the
    // reasons in `withheld`. The screen used to drop the whole body here.
    await mount({
      sharing: false, count: 0, travelers: [],
      level: 'L0_AGGREGATE', withheld: ['ghost_mode'],
      degraded: false, degradedReasons: [],
    });
    await waitFor(() => expect(screen.getByTestId('layover-presence-withheld')).toBeTruthy());
    expect(screen.queryByText(FIRST)).toBeNull();
  });

  it('4. a measured zero still says "you\'re the first"', async () => {
    await mount({
      sharing: true, city: 'Bangkok', count: 0, travelers: [],
      level: 'L2_DISCOVERY', degraded: false, degradedReasons: [],
    });
    await waitFor(() => expect(screen.getByText(FIRST)).toBeTruthy());
    expect(screen.queryByTestId('layover-presence-unmeasured')).toBeNull();
    expect(screen.queryByTestId('layover-presence-withheld')).toBeNull();
  });

  it('5. a measured count is still rendered as a count', async () => {
    await mount({
      sharing: true, city: 'Bangkok', count: 3, travelers: [],
      level: 'L0_AGGREGATE', degraded: false, degradedReasons: [],
    });
    await waitFor(() =>
      expect(screen.getByText(/3 travelers are also on a layover here/i)).toBeTruthy());
  });
});
