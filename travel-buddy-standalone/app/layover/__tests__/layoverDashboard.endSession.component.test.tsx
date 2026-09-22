/**
 * Layover dashboard — ending a layover carries an OUTCOME and an ELECTION.
 *
 * ── CENSUS L19 (§3) and L162 (§17) ───────────────────────────────────────────
 * L19: *"the boundary holds — the stamp carries a city name only. But it fires
 * at session CREATION, not post-session, and the only gate is the
 * `passport_stamps_enabled` flag; the user never elects it."*
 * L162: *"A stamp is written automatically at session CREATION … before the
 * traveller has completed anything and without electing anything."*
 *
 * The CLIENT half of that was that `endLayoverSession(id)` issued a bare
 * DELETE. It sent no outcome, so a traveller who came back and boarded was
 * recorded as having ABANDONED the layover — `status = 'completed'` has had a
 * route that accepts it since census §7 and never had a caller that sent it —
 * and it sent no election, because the stamp had already been minted when they
 * filled in the form.
 *
 * ── WHAT THIS PINS, AND WHY IT IS A SEPARATE FILE ────────────────────────────
 * The assertions are about the ARGUMENTS the screen sends, not about the sheet
 * rendering: a sheet that renders perfectly and posts nothing is the same
 * defect in a nicer coat.
 *
 * It is its own file rather than five more cases in
 * `layoverDashboard.safeReturn.component.test.tsx` because that file's §15.1
 * cases deliberately leave an abort in flight across a test boundary (the
 * deferred in "two taps are one POST"), and cases appended after it inherited
 * the leakage: they passed alone and in a `-t 'L123|L19'` run, and failed after
 * the L42 block, with the dashboard not finishing its first load inside
 * waitFor's window. Repairing that is another lane's test hygiene, not this
 * census pass's. The duplication is the mock header below and nothing else.
 *
 * ── MUTATIONS RUN ────────────────────────────────────────────────────────────
 * Recorded in §17.4 of docs/architecture/census-layover.md.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportEssentialsCard', () => ({ AirportEssentialsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPlanSection', () => ({ LayoverPlanSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return { LayoverMapCard: () => <View testID="layover-map-card-stub" /> };
});
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
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
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
  sendLayoverTelegraph: jest.fn(async () => null),
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
});

// ══════════════════════════════════════════════════════════════════════════
// §3 L19 · §17 L162 — the close carries an OUTCOME and an ELECTION
// ══════════════════════════════════════════════════════════════════════════

async function openEndSheet() {
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-end-open')).toBeTruthy());
  layoverService.endLayoverSession.mockClear();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-open')); });
  await waitFor(() => expect(screen.getByTestId('layover-end-sheet')).toBeTruthy());
}

test('the End control opens a sheet that asks how the layover ended', async () => {
  await openEndSheet();
  expect(screen.getByText('How did this layover end?')).toBeTruthy();
  expect(screen.getByTestId('layover-end-completed')).toBeTruthy();
  expect(screen.getByTestId('layover-end-cancelled')).toBeTruthy();
  // Opening the sheet closes nothing.
  expect(layoverService.endLayoverSession).not.toHaveBeenCalled();
});

test('L19/L162 — "I made my flight" closes the session as COMPLETED', async () => {
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect(layoverService.endLayoverSession).toHaveBeenCalledTimes(1));
  expect(layoverService.endLayoverSession).toHaveBeenCalledWith('sess-1', { outcome: 'completed', passportStamp: false });
});

test('L19/L162 — the Passport election is OFF until the traveller ticks it', async () => {
  await openEndSheet();
  // That the box is OFF by default is proved by the case above, which sends
  // false without touching it; that it is a real control is proved here, by
  // one press sending true. Either case alone would pass over a checkbox
  // wired to a constant.
  expect(screen.getByTestId('layover-end-stamp-election')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-stamp-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect(layoverService.endLayoverSession).toHaveBeenCalledTimes(1));
  expect(layoverService.endLayoverSession).toHaveBeenCalledWith('sess-1', { outcome: 'completed', passportStamp: true });
});

test('L19/L162 — ending early is CANCELLED and never elects a stamp', async () => {
  await openEndSheet();
  // Even with the box ticked: the election is about a COMPLETED layover, and
  // the sheet must not send one for an abandonment.
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-stamp-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-cancelled')); });
  await waitFor(() => expect(layoverService.endLayoverSession).toHaveBeenCalledTimes(1));
  expect(layoverService.endLayoverSession).toHaveBeenCalledWith('sess-1', { outcome: 'cancelled', passportStamp: false });
});

test('L19/L162 — "Keep going" closes nothing at all', async () => {
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-keep-going')); });
  expect(layoverService.endLayoverSession).not.toHaveBeenCalled();
});

test('a stamp the server refused is reported, not swallowed', async () => {
  layoverService.endLayoverSession.mockResolvedValueOnce({
    ok: true, outcome: 'completed',
    passportStamp: { requested: true, written: false, reason: 'no_city' },
  });
  await openEndSheet();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-stamp-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  await waitFor(() => expect(screen.getByText(/Passport stamp could not be saved/)).toBeTruthy());
});
