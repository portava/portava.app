/**
 * Layover dashboard (app/layover/[id].tsx) — layover round 2, lane A:
 *
 *   L148  the overview's `disruption` member — the SERVER's memory of the flight —
 *         reaches the disruption card, so a reload shows what the server
 *         recorded (from any device), and this phone's copy only when the
 *         server could not read its ledger;
 *   L189  the stored-answer card is mounted on the live screen when the overview
 *   L191  says its answer was STORED, and calls explain / replay with the
 *         overview's own snapshot id and engine version — and is absent in
 *         production's state today (nothing stored).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LayoverDashboardScreen from '../[id].tsx';
import { explainLayoverDecision, replayLayoverDecisions } from '../../../src/services/layover';
import { rememberDisruption } from '../../../src/services/layoverDisruption';

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

function overview(certifiedAt: string, hardReturnTime: string, status = 'active', extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

// NOTE: intentional stub — the wire behaviour of these calls is covered by the
// service-level tests (LayoverDecisionRecordCard.component.test.tsx drives the real
// explain/replay calls); here the screen only needs data to render and the two
// record calls are observed. The overview is a QUEUE: each read takes the next answer.
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
  explainLayoverDecision: jest.fn(async () => ({ ok: false, kind: 'unavailable', reason: 'feature_disabled', retryable: false })),
  replayLayoverDecisions: jest.fn(async () => ({ ok: false, kind: 'unavailable', reason: 'feature_disabled', retryable: false })),
}));

const NO_HELP = {
  rebooking: { available: false, reason: 'no_airline_integration' },
  airlineContact: { available: false, reason: 'no_airline_directory' },
  airportHelp: { available: false, reason: 'no_airport_help_directory' },
};
const SNAP = 'snap:' + 'c3'.repeat(16);

beforeEach(async () => {
  await AsyncStorage.clear();
  (explainLayoverDecision as jest.Mock).mockClear();
  (replayLayoverDecisions as jest.Mock).mockClear();
  // Nothing here may reach the network: the disruption card only reads its device copy.
  (global as any).fetch = jest.fn(async (url: string) => { throw new Error(`test: unexpected request ${url}`); });
});

async function mountWith(extra: Record<string, unknown>) {
  (global as any).__overviews = [overview(CERTIFIED_A, HARD_RETURN_A, 'active', extra)];
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('layover-disruption-card')).toBeTruthy());
}

const phoneCopy = (state: string) => rememberDisruption('sess-1', {
  source: 'traveller', previousState: 'CONNECTION', previousStateSource: 'default', state,
  event: { kind: 'delay', delayMinutes: 60 }, baselineDepartureTime: null, stateRecorded: true,
  recompute: null, recovery: { recoveryNeeded: false, ...NO_HELP }, safeReturn: null, certification: null,
});

test('L148 — the reload shows the server\'s CANCELLED (reported from another device), not this phone\'s DELAYED copy', async () => {
  await phoneCopy('DELAYED');
  await mountWith({
    disruption: {
      status: 'known', state: 'CANCELLED', source: 'ledger', reportedBy: 'traveller', recordedAt: '2026-09-08T09:30:00.000Z',
      baselineDepartureTime: '2026-09-08T16:00:00.000Z', recovery: { recoveryNeeded: true, ...NO_HELP },
    },
  });
  await waitFor(() => expect(screen.getByTestId('layover-disruption-server-status')).toBeTruthy());
  expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
  expect(screen.queryByTestId('layover-disruption-remembered')).toBeNull();
  expect(screen.getByTestId('layover-disruption-report-rebooking_offered')).toBeTruthy();
});

test('L148 — the server could not read its ledger: this phone\'s copy, captioned, beside the sentence that says so', async () => {
  await phoneCopy('DELAYED');
  await mountWith({ disruption: { status: 'unknown', reason: 'ledger_unreadable', message: 'Portava could not read this flight\'s disruption history just now.' } });
  await waitFor(() => expect(screen.getByTestId('layover-disruption-remembered')).toBeTruthy());
  expect(screen.getByTestId('layover-disruption-state-DELAYED')).toBeTruthy();
  expect(screen.getByText('Portava could not read this flight\'s disruption history just now.')).toBeTruthy();
});

test('L189 / L191 — production today (nothing stored): the stored-answer card is not on the screen', async () => {
  await mountWith({ snapshotId: SNAP, persisted: { state: 'not_stored', reason: 'persistence_disabled' } });
  expect(screen.queryByTestId('layover-decision-record-card')).toBeNull();
});

test('L189 / L191 — a STORED answer: the card is on the screen and asks about THIS answer, under THIS engine', async () => {
  await mountWith({ snapshotId: SNAP, persisted: { state: 'recorded', unwritten: [] } });
  await waitFor(() => expect(screen.getByTestId('layover-decision-record-card')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('layover-decision-explain'));
  await waitFor(() => expect(explainLayoverDecision).toHaveBeenCalledWith('sess-1', SNAP));
  await waitFor(() => expect(screen.getByTestId('layover-decision-explain-unavailable')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('layover-decision-replay'));
  // The overview fixture's certification names engine 'v'.
  await waitFor(() => expect(replayLayoverDecisions).toHaveBeenCalledWith('sess-1', 'v'));
});
