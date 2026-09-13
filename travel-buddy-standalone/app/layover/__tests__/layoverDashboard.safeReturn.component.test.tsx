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
 *
 * WIDENED 2026-09-13 (second pass): the §13 exploration collapse. See the block
 * of cases at the end of this file — and note that the sibling sections it
 * collapses are the STUBS above, so what those cases assert is the screen's own
 * decision to mount them or not, which is precisely the claim.
 *
 * WIDENED 2026-09-13: LayoverFlightChangeCard joins them, for the same reason
 * and with a sharper edge. It is the ONLY thing on this tree that produces a
 * §11 event, so the whole eight-step replanner is reachable by exactly one
 * component being in exactly one tree. A card that stopped being mounted would
 * take the pipeline back to having no caller outside `src/test/`, and every
 * other test in the repository would stay green.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
  // §17.1 L165 — whether an OS dialog is about to appear. Driven per test.
  notificationPromptWouldAppear: jest.fn(async () => false),
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
  updateLayoverSession: jest.fn(async () => ({
    session: (global as any).__overview.session,
    replan: { ran: false, reason: 'window_unchanged', detail: 'no feasibility input moved' },
  })),
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

test('the dashboard mounts the flight-change card — the §11 ingest reaches a traveller', async () => {
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-flight-change-card')).toBeTruthy());
  // The producer control itself, not just the card frame.
  expect(screen.getByTestId('flight-shift-60')).toBeTruthy();
  expect(screen.getByTestId('flight-shift--15')).toBeTruthy();
});

// ── §13 L120 / L141 — the exploration block collapses on the certified posture ─
//
// WIDENED 2026-09-13 (second pass). `explorationCollapsed` had been derived,
// published, tested server-side and read by NOTHING for two censuses, while
// `returnRoutePrimary` — the field beside it in the same object — was read.
// That is the failure mode this file was written for, one field over.
//
// Every case below drives `explorationCollapsed` INDEPENDENTLY of
// `returnRoutePrimary`, because the two are equal in production
// (`safeReturnPosture` sets both to `escalated`) and a test that moved them
// together would pass just as happily against a screen that read the wrong one.
//
// MUTATIONS RUN AGAINST `app/layover/[id].tsx`, each reverted and `cmp`-verified
// byte-identical afterwards. 9 pass / 0 fail unmutated:
//   1. the derivation keyed off `returnRoutePrimary` instead of
//      `explorationCollapsed` ............................... 4 failed
//   2. the derivation forced to `false` (never collapse) ..... 3 failed
//   3. "Show them anyway" wired to a no-op `onPress` ......... 1 failed
//   4. `&& !showExploration` dropped, so the override cannot win
//      ..................................................... 1 failed
//
// Mutation 1 is the one worth reading. It fails FOUR cases and not one, because
// three of the four collapse cases carry `returnRoutePrimary: false` — if the
// fixture had moved the two fields together the way production does, a screen
// reading the wrong field would have been green.

function postureOverview(patch: Record<string, unknown>) {
  const base = overview(false);
  return { ...base, safeReturn: { ...base.safeReturn, ...patch } };
}

test('a collapsed posture replaces the exploration block with a notice', async () => {
  (global as any).__overview = postureOverview({
    explorationCollapsed: true,
    returnState: 'RETURN_NOW',
    primaryAction: 'return_now',
  });
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-exploration-collapsed')).toBeTruthy());
  expect(screen.queryByTestId('layover-exploration')).toBeNull();
  expect(screen.getByTestId('layover-exploration-collapsed-title')).toHaveTextContent(
    "It's time to head back",
  );
  // The explainer is NOT an exploration affordance and stays mounted.
  expect(screen.getByTestId('layover-compass-card')).toBeTruthy();
  // §15.1 — so does the abort.
  expect(screen.getByTestId('return-to-airport-btn')).toBeTruthy();
});

test('CONNECTION_AT_RISK names the reason it collapsed', async () => {
  (global as any).__overview = postureOverview({
    explorationCollapsed: true,
    returnState: 'CONNECTION_AT_RISK',
    primaryAction: 'recover_connection',
  });
  await render(<LayoverDashboardScreen />);

  // Scoped to the notice's own node: the Safe Return card says the same
  // sentence in the same posture, and an unscoped getByText finds both.
  await waitFor(() =>
    expect(screen.getByTestId('layover-exploration-collapsed-title')).toHaveTextContent(
      'Your connection is at risk',
    ),
  );
});

test('collapsed is not hidden — one press restores the whole block', async () => {
  (global as any).__overview = postureOverview({
    explorationCollapsed: true,
    returnState: 'RETURN_NOW',
    primaryAction: 'return_now',
  });
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-exploration-show-anyway')).toBeTruthy());
  fireEvent.press(screen.getByTestId('layover-exploration-show-anyway'));
  await waitFor(() => expect(screen.getByTestId('layover-exploration')).toBeTruthy());
  expect(screen.queryByTestId('layover-exploration-collapsed')).toBeNull();
});

test('the collapse is keyed on explorationCollapsed, not on the hoist beside it', async () => {
  // returnRoutePrimary TRUE, explorationCollapsed FALSE: the card hoists and
  // the city stays. A screen that keyed the collapse off the hoist fails here.
  (global as any).__overview = postureOverview({
    explorationCollapsed: false,
    returnRoutePrimary: true,
    returnState: 'RETURN_NOW',
    primaryAction: 'return_now',
  });
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-exploration')).toBeTruthy());
  expect(screen.queryByTestId('layover-exploration-collapsed')).toBeNull();
  const order = testIdOrder();
  expect(order.indexOf('layover-safe-return-card')).toBeLessThan(order.indexOf('layover-hero-stub'));
});

test('a NORMAL posture leaves the exploration block standing', async () => {
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-exploration')).toBeTruthy());
  expect(screen.queryByTestId('layover-exploration-collapsed')).toBeNull();
});

// ── §17.1 L165 — the permission is explained BEFORE the OS asks ──────────────
//
// The request was already contextual — it fires inside the "Remind me" tap and
// nowhere else — and that half was never the gap. The gap was that nothing said
// WHY, and the OS dialog cannot: the sentence it shows is the app's name and
// the word "notifications".
//
// MUTATIONS, each against the screen, reverted and `cmp`-verified. 13 pass / 0
// fail unmutated:
//   1. `handleReminder` calling `scheduleReminder` directly (no sheet) 3 failed
//   2. the probe replaced by `true` — the sheet shown unconditionally   1 failed
//   3. "Not now" wired to `scheduleReminder` instead of dismissing      1 failed

const notifications = require('../../../src/lib/safeNotifications');
const layoverService = require('../../../src/services/layover');

test('a traveller whose phone is about to ask is told why first', async () => {
  notifications.notificationPromptWouldAppear.mockResolvedValueOnce(true);
  layoverService.setReturnDeadline.mockClear();
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
  fireEvent.press(screen.getByTestId('layover-remind-me'));

  await waitFor(() => expect(screen.getByText('Let us warn you when to head back')).toBeTruthy());
  // The reason is SPECIFIC to this permission, not a generic "enable alerts".
  expect(screen.getByText(/safe return time can move/)).toBeTruthy();
  // Nothing has been scheduled or written yet — the explanation precedes the ask.
  expect(layoverService.setReturnDeadline).not.toHaveBeenCalled();
  expect(notifications.scheduleLocalNotificationAt).not.toHaveBeenCalled();
});

test('continuing from the rationale proceeds to the real reminder', async () => {
  notifications.notificationPromptWouldAppear.mockResolvedValueOnce(true);
  layoverService.setReturnDeadline.mockClear();
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
  fireEvent.press(screen.getByTestId('layover-remind-me'));
  await waitFor(() => expect(screen.getByText('Continue')).toBeTruthy());
  fireEvent.press(screen.getByText('Continue'));

  await waitFor(() => expect(layoverService.setReturnDeadline).toHaveBeenCalledWith('sess-1', 30));
});

test('a traveller who already granted permission is not shown an explanation', async () => {
  // The probe answers false, which is the production case for anyone who has
  // used the reminder once. An explanation on every tap is how people learn to
  // dismiss the one that matters.
  layoverService.setReturnDeadline.mockClear();
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
  fireEvent.press(screen.getByTestId('layover-remind-me'));

  await waitFor(() => expect(layoverService.setReturnDeadline).toHaveBeenCalledWith('sess-1', 30));
  expect(screen.queryByText('Let us warn you when to head back')).toBeNull();
});

test('"Not now" dismisses the explanation and asks the OS for nothing', async () => {
  notifications.notificationPromptWouldAppear.mockResolvedValueOnce(true);
  layoverService.setReturnDeadline.mockClear();
  notifications.scheduleLocalNotificationAt.mockClear();
  (global as any).__overview = overview(false);
  await render(<LayoverDashboardScreen />);

  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
  fireEvent.press(screen.getByTestId('layover-remind-me'));
  await waitFor(() => expect(screen.getByText('Not now')).toBeTruthy());
  fireEvent.press(screen.getByText('Not now'));

  await waitFor(() => expect(screen.queryByText('Let us warn you when to head back')).toBeNull());
  expect(layoverService.setReturnDeadline).not.toHaveBeenCalled();
  expect(notifications.scheduleLocalNotificationAt).not.toHaveBeenCalled();
});
