/**
 * Layover dashboard (app/layover/[id].tsx) — census-layover L148, L149, L231:
 * the disruption report is REACHABLE from the layover screen, and its answer
 * reaches every other surface.
 *
 * `LayoverDisruptionCard.component.test.tsx` proves what the card sends and
 * renders. This file proves the SCREEN's half, which is where the census's
 * remaining gap was: `POST /:id/disruption` existed and no client called it.
 *
 *   1. The card is mounted on a live layover, with the new-departure field
 *      pre-filled from the SERVER's airport-local departure.
 *   2. L149 — after a report the screen RE-READS the overview, so the hero and
 *      the map hold the new certification, not the one the report replaced.
 *   3. L231 — a cancellation from the screen lands on CANCELLED with the
 *      recovery posture and the rebooking reports offered.
 *   4. A layover the server no longer accepts reports for gets no controls.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LayoverDashboardScreen from '../[id].tsx';
import { getLayoverOverview } from '../../../src/services/layover';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'sess-1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

// NOTE: intentional stub — requireActual pulls native-module internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentional stub — expo-notifications needs a native runtime.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stub — the real helper reads a Supabase session through the
// native SecureStore adapter; a fixed token is all the disruption wire needs.
jest.mock('../../../src/services/apiToken', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

// ── Surfaces that must show the RE-READ certification: captured, not rendered ──
// NOTE: intentional stub — the hero's props are what this file reads.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: (props: any) => { (global as any).__heroWindow = props.window; return <View testID="layover-hero-stub" />; } };
});
// NOTE: intentional stub — the map's props are what this file reads.
jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return { LayoverMapCard: (props: any) => { (global as any).__mapProps = props; return <View testID="layover-map-card-stub" />; } };
});

// ── Heavy sibling sections, stubbed to null ───────────────────────────────────
// NOTE: intentional stub — none of them is under test here.
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
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverSafeReturnCard', () => ({ LayoverSafeReturnCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewLocationCard', () => ({ LayoverCrewLocationCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverDiscoveryCard', () => ({ LayoverDiscoveryCard: () => null }));

const CERTIFIED_A = '2026-09-08T10:00:00.000Z';
const CERTIFIED_B = '2026-09-08T10:05:00.000Z';
const HARD_RETURN_A = '2026-09-08T13:40:00.000Z';
const HARD_RETURN_B = '2026-09-08T14:50:00.000Z';

function overview(certifiedAt: string, hardReturnTime: string, status = 'active') {
  const certification = {
    engineVersion: 'v', feasibilityVersion: 'v', inputHash: certifiedAt,
    computedAt: certifiedAt, verdict: 'tight', confidence: 'LOW', bufferPercentile: 'p90',
  };
  return {
    session: {
      id: 'sess-1', userId: 'u-1', airportId: 'ap-1', tripId: null,
      arrivalTime: '2026-09-08T08:00:00.000Z', departureTime: '2026-09-08T16:00:00.000Z',
      boardingTime: null, layoverMinutes: 480, flightType: 'international',
      immigrationRequired: true, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: 'moderate', vibeChips: [],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
      status, createdAt: '2026-09-08T07:00:00.000Z',
    },
    airport: {
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok',
      country: 'Thailand', countryCode: 'TH', timezone: 'Asia/Bangkok',
      lat: 13.68, lng: 100.74, verified: false,
    },
    window: {
      totalMinutes: 480, exitDelayMin: 40, returnBufferMin: 95, usableMinutes: 345,
      hardReturnTime, earliestOutTime: '2026-09-08T08:40:00.000Z',
      breakdown: { baseBuffer: 60, immigrationExtra: 20, bagsExtra: 15, trafficExtra: 0, timeOfDayExtra: 0, totalBuffer: 95, exitDelay: 40 },
      tier: 'half_day', tierLabel: 'Half day', tierBlurb: 'Plenty of time.',
      overnight: false, returnState: 'NORMAL', engineVersion: 'v',
    },
    advice: { verdict: 'tight', reasons: [], unknowns: [], reasonCodes: [], disclaimer: 'Estimates only.', engineVersion: 'v' },
    stops: [],
    planFit: { totalPlannedMin: 0, returnTravelMin: 0, neededMin: 0, usableMinutes: 345, fitsWindow: true, fit: 'fits', unstatedTravelStops: 0, unstatedDurationStops: 0, neededMinIsLowerBound: false, overflowMin: 0, backByTime: hardReturnTime },
    share: { enabled: false, othersInCity: 0 },
    certification,
    airportIntelligence: null,
    safeReturn: {
      safeReturnVersion: 'v', returnState: 'NORMAL',
      explorationCollapsed: false, returnRoutePrimary: false,
      pinTerminalContext: false, notifyCrew: false, offerRecoveryHelp: false,
      primaryAction: 'explore', abortAvailable: true, minutesToHardReturn: 220,
    },
    offlineBundle: {
      bundleVersion: 'v', sessionId: 'sess-1',
      certifiedAt, staleAfter: '2026-09-08T10:15:00.000Z',
      certification,
      returnDeadline: { hardReturnTime, hardReturnLocal: '20:40', returnState: 'NORMAL', bufferMinutes: 95, returnReminderAt: null },
      airport: { iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand', timezone: 'Asia/Bangkok', lat: 13.68, lng: 100.74, terminalInfo: null },
      mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
      route: { available: false, value: null, reason: 'no_routing_provider' },
      flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
      crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
      translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
      stops: [],
    },
    safeEnvelope: null,
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '17:00', airportToday: '2026-09-08',
      arrivalLocal: '15:00', arrivalDay: '2026-09-08',
      departureLocal: '23:00', departureDay: '2026-09-08',
      boardingLocal: null, hardReturnLocal: '20:40',
    },
  };
}

// NOTE: intentional stub — the wire behaviour of these calls is covered by the
// service-level tests; here the screen only needs data to render. The overview
// is a QUEUE so a re-read is observable: each read takes the next answer.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => {
    const q = (global as any).__overviews as unknown[];
    return { ok: true, overview: q.length > 1 ? q.shift() : q[0] };
  }),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ ok: true, city: 'Bangkok', buddies: [], refusal: null, safetyGate: null, trustRequirement: null, degraded: false, degradedReasons: [] })),
  getLayoverPresence: jest.fn(async () => ({ sharing: false, count: 0, travelers: [] })),
  getLayoverDiscovery: jest.fn(async () => ({ ok: true, gems: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => ({ ok: true, outcome: 'cancelled', passportStamp: { requested: false, written: false, reason: 'not_elected' } })),
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

const POSTURE = {
  recoveryNeeded: true,
  rebooking: { available: false, reason: 'no_airline_integration' },
  airlineContact: { available: false, reason: 'no_airline_directory' },
  airportHelp: { available: false, reason: 'no_airport_help_directory' },
};

let disruptionBodies: unknown[] = [];
let posts: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  (global as any).__heroWindow = undefined;
  (global as any).__mapProps = undefined;
  (global as any).__overviews = [overview(CERTIFIED_A, HARD_RETURN_A), overview(CERTIFIED_B, HARD_RETURN_B)];
  (getLayoverOverview as jest.Mock).mockClear();
  disruptionBodies = [];
  posts = [];
  // Only the disruption route answers; any other request is a test error.
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    if (!/\/disruption$/.test(url)) throw new Error(`test: unexpected request ${url}`);
    posts.push(JSON.parse(String(init.body)));
    const body = disruptionBodies.shift();
    return { ok: true, status: 200, json: async () => body };
  });
});

async function mountLive() {
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('layover-disruption-card')).toBeTruthy());
}

test('1. the disruption card is on the live layover screen, pre-filled with the server\'s local departure', async () => {
  await mountLive();
  expect(screen.getByTestId('layover-disruption-controls')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
  expect(screen.getByTestId('layover-disruption-new-departure').props.value).toBe('2026-09-08 23:00');
});

test('2. L149: after a delay report the screen RE-READS the overview, and the hero and map hold the NEW certification', async () => {
  disruptionBodies.push({
    ok: true,
    disruption: { source: 'traveller', previousState: 'CONNECTION', previousStateSource: 'default', state: 'DELAYED', event: { kind: 'delay', delayMinutes: 120 }, baselineDepartureTime: '2026-09-08T16:00:00.000Z', stateRecorded: true },
    recompute: {
      scheduleDeltaMinutes: 120, usableMinutesDelta: 70, recomputedNotAppended: true, returnStateChanged: false,
      before: { usableMinutes: 345, returnState: 'NORMAL', hardReturnTime: HARD_RETURN_A },
      after: { usableMinutes: 415, returnState: 'NORMAL', hardReturnTime: HARD_RETURN_B, hardReturnLocal: '21:50' },
    },
    recovery: { ...POSTURE, recoveryNeeded: false }, safeReturn: null, certification: null,
  });
  await mountLive();
  expect((global as any).__heroWindow.hardReturnTime).toBe(HARD_RETURN_A);
  const readsBefore = (getLayoverOverview as jest.Mock).mock.calls.length;

  await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
  await fireEvent.changeText(screen.getByTestId('layover-disruption-new-departure'), '2026-09-09 01:00');
  await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));

  await waitFor(() => expect(screen.getByTestId('layover-disruption-recompute')).toBeTruthy());
  expect(posts).toEqual([{ kind: 'delay', newDepartureLocal: '2026-09-09 01:00' }]);
  // The re-read, and every surface on it.
  await waitFor(() => expect((getLayoverOverview as jest.Mock).mock.calls.length).toBe(readsBefore + 1));
  await waitFor(() => expect((global as any).__heroWindow.hardReturnTime).toBe(HARD_RETURN_B));
  expect((global as any).__mapProps.offline.certifiedAt).toBe(CERTIFIED_B);
  expect((global as any).__mapProps.airportReturn.hardReturnTime).toBe(HARD_RETURN_B);
  // The card stayed mounted through the refresh and still shows the server's answer.
  expect(screen.getByTestId('layover-disruption-state-DELAYED')).toBeTruthy();
});

test('3. L231: a cancellation from the screen lands on CANCELLED with the honest recovery posture and REBOOKING next', async () => {
  disruptionBodies.push({
    ok: true,
    disruption: { source: 'traveller', previousState: 'CONNECTION', previousStateSource: 'default', state: 'CANCELLED', event: { kind: 'cancellation' }, baselineDepartureTime: '2026-09-08T16:00:00.000Z', stateRecorded: true },
    recompute: null, recovery: POSTURE, safeReturn: null, certification: null,
  });
  await mountLive();
  await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
  await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));

  await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
  expect(posts).toEqual([{ kind: 'cancellation' }]);
  expect(screen.getByTestId('layover-disruption-recovery')).toBeTruthy();
  expect(screen.getByText(/Rebooking: unavailable/)).toBeTruthy();
  expect(screen.getByTestId('layover-disruption-report-rebooking_offered')).toBeTruthy();
  await waitFor(() => expect((global as any).__heroWindow.hardReturnTime).toBe(HARD_RETURN_B));
});

test('4. a layover that has ended gets no disruption controls', async () => {
  (global as any).__overviews = [overview(CERTIFIED_A, HARD_RETURN_A, 'completed')];
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
  expect(screen.queryByTestId('layover-disruption-card')).toBeNull();
  expect(posts).toHaveLength(0);
});

test('5. a RETURNING layover still has the controls: the route accepts reports from a returning session', async () => {
  (global as any).__overviews = [overview(CERTIFIED_A, HARD_RETURN_A, 'returning')];
  await mountLive();
  expect(screen.getByTestId('layover-disruption-controls')).toBeTruthy();
});
