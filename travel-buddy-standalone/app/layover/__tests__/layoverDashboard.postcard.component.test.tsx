/**
 * Layover dashboard — census-layover L275, the POSTCARD half of §25.
 *
 * Layover spec §25: "convert a COMPLETED session into an optional
 * stamp/postcard/memory". Two doors open the ordinary postcard composer for a
 * layover, and both are about a layover that ENDED WITH THE FLIGHT:
 *
 *   1. the end sheet's "Make a postcard" election — the composer opens only
 *      after the SERVER has recorded the close as completed;
 *   2. the snapshot of a completed layover — a "Make a postcard" action that a
 *      cancelled, expired or active layover never shows.
 *
 * The screen only ever shows the viewer's own layover (the overview route is
 * owner-only: `ownedSessionOr` in routes/airport.ts), and the server refuses a
 * postcard of anyone else's layover as not_found (api-server
 * src/test/layoverPostcard.test.ts). The mock header is copied from
 * layoverDashboard.endSession.component.test.tsx, plus a composer stub.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'sess-1' }),
  useRouter: () => ({ push: jest.fn(), back: (global as any).__routerBack, replace: jest.fn() }),
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
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// ── Heavy sibling sections, stubbed to null ───────────────────────────────────
// NOTE: intentional stubs — each pulls maps, discovery or presence chains that
// are irrelevant to what the End control sends.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: () => <View testID="layover-hero-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null })); jest.mock('../../../src/components/layover/LayoverConstraintsCard', () => ({ LayoverConstraintsCard: () => null })); // NOTE: intentional stub — the card has its own suite (LayoverConstraintsCard.component.test.tsx)
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportEssentialsCard', () => ({ AirportEssentialsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPlanSection', () => ({ LayoverPlanSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: (p: any) => { (global as any).__recsProps = p; return null; } })); // records props for the census L43 case
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return { LayoverMapCard: () => <View testID="layover-map-card-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: (p: any) => { (global as any).__peopleProps = p; return null; } })); // records props for the census L129 case

// NOTE: intentional stub — the composer has its own suite
// (src/components/__tests__/PostcardComposer.layover.component.test.tsx); here
// the claim is WHEN the screen opens it and WHAT it hands it.
jest.mock('../../../src/components/PostcardComposer', () => {
  const { View, Pressable, Text } = require('react-native');
  return {
    PostcardComposer: (p: any) => {
      (global as any).__composerProps = p;
      return (
        <View testID="postcard-composer-stub">
          <Pressable testID="postcard-composer-close" onPress={p.onClose}><Text>close</Text></Pressable>
        </View>
      );
    },
  };
});

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

function overview() {
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
      overnight: false, returnState: 'NORMAL', engineVersion: '2026.09.02-3',
    },
    advice: {
      verdict: 'tight', reasons: [], unknowns: [], reasonCodes: [],
      disclaimer: 'Estimates only.', engineVersion: '2026.09.02-3',
    },
    stops: [],
    planFit: { totalPlannedMin: 0, returnTravelMin: 0, neededMin: 0, usableMinutes: 345, fitsWindow: true, overflowMin: 0, backByTime: HARD_RETURN },
    share: { enabled: false, othersInCity: 0 },
    certification: CERTIFICATION,
    airportIntelligence: {
      tier: 'AIRPORT_RECORD', airportAddressable: true, airportVerified: false,
      liveObserved: false, bufferSourceClass: 'AIRPORT_PROFILE', bufferFallbackLevel: 2,
      confidence: 'LOW', sourceRefs: ['airport_profiles.international_buffer_min'],
    },
    safeReturn: {
      safeReturnVersion: '2026.09.08-1',
      returnState: 'NORMAL',
      explorationCollapsed: false,
      returnRoutePrimary: false,
      pinTerminalContext: false,
      notifyCrew: false,
      offerRecoveryHelp: false,
      primaryAction: 'explore',
      abortAvailable: true,
      minutesToHardReturn: 220,
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

// NOTE: intentional stub — the wire shape of `endLayoverSession` is covered by
// the server suite (src/test/layoverCompletionStamp.test.ts, which drives the
// real router). Here the claim is about what the SCREEN hands it.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ ok: true, city: 'Bangkok', buddies: [], refusal: null, safetyGate: null, trustRequirement: null, degraded: false, degradedReasons: [] })),
  getLayoverPresence: jest.fn(async () => ({ sharing: false, count: 0, travelers: [] })),
  // census L269 — the screen mounts LayoverDiscoveryCard, which reads through
  // this module. Kept in step with the exhaustive list above: an omission here
  // does not fail as a missing card, it throws inside the render.
  getLayoverDiscovery: jest.fn(async () => ({ ok: true, gems: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => ({
    ok: true, outcome: 'cancelled',
    passportStamp: { requested: false, written: false, reason: 'not_elected' },
  })),
  sendLayoverTelegraph: jest.fn(async () => null), createMemoryFromLayover: jest.fn(async () => ({ ok: true, memoryId: 'm-1', existing: false })), // census L275
  setReturnDeadline: jest.fn(async () => null),
  setShareCityStatus: jest.fn(async () => null),
  returnToAirportNow: jest.fn(async () => ({ kind: 'offline' })),
  askCompass: jest.fn(async () => null),
  // §10 L82 and §14 L28/L29 — the observation card and the crew section fetch
  // their own data on mount, so the module mock has to know they exist. Both
  // are stubbed in their SUCCESSFUL-BUT-EMPTY state rather than as failures:
  // a `null` from either is a FAILED READ in the real client and renders a
  // retry, which would put an error affordance into every dashboard test that
  // is not about errors.
  getAirportObservations: jest.fn(async () => ({
    airportRef: 'BKK',
    submittableFactTypes: ['queue_report_minutes', 'checkpoint_timing_minutes', 'closure_reported'],
    rateLimit: { maxPerWindow: 3, windowMinutes: 15 },
    facts: [],
  })),
  submitAirportObservation: jest.fn(async () => ({ ok: false, message: 'stub', rateLimited: false })),
  getLayoverCrew: jest.fn(async () => ({ inCrew: false, city: 'Bangkok', crews: [] })),
  createLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  joinLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  leaveLayoverCrew: jest.fn(async () => ({ ok: false, message: 'stub' })),
  updateLayoverSession: jest.fn(async () => ({
    session: (global as any).__overview.session,
    replan: { ran: false, reason: 'window_unchanged', detail: 'no feasibility input moved' },
  })),
}));

const layoverService = require('../../../src/services/layover');

beforeEach(() => {
  (global as any).__overview = overview();
  (global as any).__composerProps = null;
  (global as any).__routerBack.mockClear();
});
(global as any).__routerBack = jest.fn();

const COMPLETED = {
  ok: true, outcome: 'completed',
  passportStamp: { requested: false, written: false, reason: 'not_elected' },
};

async function openEndSheet() {
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-end-open')).toBeTruthy());
  layoverService.endLayoverSession.mockClear();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-open')); });
  await waitFor(() => expect(screen.getByTestId('layover-end-sheet')).toBeTruthy());
}

function withStatus(status: string) {
  const o = overview();
  return { ...o, session: { ...o.session, status } };
}

// ── door 1: the end sheet ───────────────────────────────────────────────────

test('L275 — ticked, the composer opens for THIS layover once the server records it completed; leaving waits for it', async () => {
  layoverService.endLayoverSession.mockResolvedValueOnce(COMPLETED);
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-postcard-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect(screen.getByTestId('postcard-composer-stub')).toBeTruthy());
  expect((global as any).__composerProps.layover).toEqual({ sessionId: 'sess-1', city: 'Bangkok' });
  // The postcard election never rides on the close.
  expect(layoverService.endLayoverSession).toHaveBeenCalledWith('sess-1', { outcome: 'completed', passportStamp: false });
  expect((global as any).__routerBack).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByTestId('postcard-composer-close')); });
  expect((global as any).__routerBack).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('postcard-composer-stub')).toBeNull();
});

test('L275 — untouched, no composer opens and the screen leaves as before', async () => {
  layoverService.endLayoverSession.mockResolvedValueOnce(COMPLETED);
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect((global as any).__routerBack).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('postcard-composer-stub')).toBeNull();
});

test('L275 — the SERVER\'s outcome decides: a close it recorded as cancelled never opens the composer', async () => {
  layoverService.endLayoverSession.mockResolvedValueOnce({ ...COMPLETED, outcome: 'cancelled' });
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-postcard-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect((global as any).__routerBack).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('postcard-composer-stub')).toBeNull();
});

test('L275 — a close that failed opens nothing', async () => {
  layoverService.endLayoverSession.mockResolvedValueOnce({ ok: false });
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-postcard-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect(screen.getByText('Could not end the layover')).toBeTruthy());
  expect(screen.queryByTestId('postcard-composer-stub')).toBeNull();
});

// ── door 2: the snapshot of a finished layover ──────────────────────────────

test('L275 — a COMPLETED layover\'s snapshot offers a postcard, and it opens the composer for that layover without leaving', async () => {
  (global as any).__overview = withStatus('completed');
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-make-postcard')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId('layover-make-postcard')); });
  await waitFor(() => expect(screen.getByTestId('postcard-composer-stub')).toBeTruthy());
  expect((global as any).__composerProps.layover).toEqual({ sessionId: 'sess-1', city: 'Bangkok' });
  await act(async () => { fireEvent.press(screen.getByTestId('postcard-composer-close')); });
  expect(screen.queryByTestId('postcard-composer-stub')).toBeNull();
  expect((global as any).__routerBack).not.toHaveBeenCalled();
});

for (const status of ['cancelled', 'expired', 'active']) {
  test(`L275 — a ${status} layover offers no postcard`, async () => {
    (global as any).__overview = withStatus(status);
    await render(<LayoverDashboardScreen />);
    await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
    expect(screen.queryByTestId('layover-make-postcard')).toBeNull();
  });
}
