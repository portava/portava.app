/**
 * Layover dashboard (app/layover/[id].tsx) — the map's THREE server inputs
 * actually reach the map.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT THE CARD'S OWN TEST ─────────────
 * `LayoverMapCard.envelope.component.test.tsx` proves the card can draw the
 * certified envelope, band a pin and badge a stale bundle. It proves nothing
 * about whether a traveller ever sees any of it: a card that renders perfectly
 * when handed props renders nothing when the screen hands it none, and that is
 * not a hypothetical failure mode on this surface — it is the recorded one.
 *
 *   `certification`, `estimates`, `safeReturn`, `offlineBundle` were all
 *   PUBLISHED by the server and read by no client type for two censuses
 *   (census-layover §9, "Reachability, measured before scoring anything").
 *   `explorationCollapsed` was derived, published, server-tested and dropped on
 *   the floor by this exact screen while `returnRoutePrimary` — the field
 *   beside it in the same object — was read.
 *
 * `safeEnvelope` has been on `GET /overview` since census L63 and was the next
 * one in that queue. So the assertions below are about the SCREEN's wiring:
 * what it pulls off the overview, what it derives from the recommendation list,
 * and what it hands down.
 *
 * ── MUTATIONS RUN against `app/layover/[id].tsx`, reverted and cmp-verified ──
 *   1. `envelope={overview.safeEnvelope ?? null}` → `envelope={null}` ... 1 failed
 *   2. `candidateFeasibility` keyed by `recType` instead of `r.id` ...... 1 failed
 *   3. the `offline` prop dropped .................................... 1 failed
 *   4. `r.feasibility` folded in even when absent (`?? {}`) ........... 1 failed
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';

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

// ── Heavy sibling sections, stubbed to null ───────────────────────────────────
// NOTE: intentional stubs — none of them is under test here.
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
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverSafeReturnCard', () => ({ LayoverSafeReturnCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// The map card is CAPTURED, not rendered: this file is about what the screen
// hands it. What it does with those props is the card's own test.
jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return {
    LayoverMapCard: (props: any) => {
      (global as any).__mapProps = props;
      return <View testID="layover-map-card-stub" />;
    },
  };
});

const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const STALE_AFTER = '2026-09-08T10:15:00.000Z';
const HARD_RETURN = '2026-09-08T13:40:00.000Z';

const CERTIFICATION = {
  engineVersion: '2026.09.02-3', feasibilityVersion: '2026.09.05-1',
  inputHash: 'a1b2c3d4e5f60718', computedAt: CERTIFIED_AT,
  verdict: 'tight', confidence: 'LOW', bufferPercentile: 'p90',
};

const SAFE_ENVELOPE = {
  centre: { lat: 13.68, lng: 100.74 },
  radiusMetres: 37_000,
  usableMinutes: 345,
  maxOneWayMinutes: 172,
  basis: 'straight_line_lower_bound',
  certifiedOutward: true,
  certifiedInward: false,
  confidence: 'LOW',
  uncertaintyBudgetMinutes: 87,
  plannedMaxOneWayMinutes: 129,
  plannedRadiusMetres: 27_000,
};

function overview(over: Record<string, unknown> = {}) {
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
    advice: { verdict: 'tight', reasons: [], unknowns: [], reasonCodes: [], disclaimer: 'Estimates only.', engineVersion: '2026.09.02-3' },
    stops: [
      {
        id: 'stop-a', title: 'Chatuchak', description: null, stopOrder: 1,
        durationMin: 90, travelMin: 0, placeId: null, recommendationId: 'rec-a',
        lat: 13.79, lng: 100.55, locationLabel: 'Chatuchak', insideAirport: false,
        source: 'recommendation',
      },
    ],
    planFit: { totalPlannedMin: 90, returnTravelMin: 0, neededMin: 90, usableMinutes: 345, fitsWindow: true, fit: 'unknown', unstatedTravelStops: 1, unstatedDurationStops: 0, neededMinIsLowerBound: true, overflowMin: 0, backByTime: HARD_RETURN },
    share: { enabled: false, othersInCity: 0 },
    certification: CERTIFICATION,
    airportIntelligence: null,
    safeReturn: {
      safeReturnVersion: '2026.09.08-1', returnState: 'NORMAL',
      explorationCollapsed: false, returnRoutePrimary: false,
      pinTerminalContext: false, notifyCrew: false, offerRecoveryHelp: false,
      primaryAction: 'explore', abortAvailable: true, minutesToHardReturn: 220,
    },
    offlineBundle: {
      bundleVersion: '2026.09.08-1', sessionId: 'sess-1',
      certifiedAt: CERTIFIED_AT, staleAfter: STALE_AFTER,
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
    safeEnvelope: SAFE_ENVELOPE,
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '17:00', airportToday: '2026-09-08',
      arrivalLocal: '15:00', arrivalDay: '2026-09-08',
      departureLocal: '23:00', departureDay: '2026-09-08',
      boardingLocal: null, hardReturnLocal: '20:40',
    },
    ...over,
  };
}

const BANDED_REC = {
  id: 'rec-a', recType: 'market', title: 'Chatuchak', description: null,
  safetyRating: 'possible_but_risky', safetyLabel: 'Tight',
  travelTimeMin: null, travelTimeSource: 'unmeasured', activityTimeMin: null,
  returnBufferMin: 95, hardReturnTime: HARD_RETURN, warningReason: null,
  insideAirport: false, locationLabel: 'Chatuchak', city: 'Bangkok',
  neighborhood: null, meetupLocationHidden: false, meetupLocationReveal: null,
  placeId: null, sortOrder: 0,
  feasibility: {
    band: 'UNCERTIFIED', certified: true, lowerBoundOneWayMin: 140,
    withinPlannedEdge: false, reason: null,
    plannedEdgeReason: 'beyond what we would plan on LOW confidence — 87 of the 345 usable minutes are held back',
    impliesFit: false,
  },
};

/** An airside card the server did NOT band. It must not enter the lookup. */
const UNBANDED_REC = {
  ...BANDED_REC, id: 'rec-b', title: 'Terminal 2 food court',
  insideAirport: true, feasibility: undefined,
};

// NOTE: intentional stub — the wire behaviour of these calls is covered by the
// service-level tests; here the screen only needs data to render.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__overview),
  getRecommendations: jest.fn(async () => (global as any).__recs),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
  getLayoverPresence: jest.fn(async () => ({ sharing: false, count: 0, travelers: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => ({ ok: true, outcome: 'cancelled', passportStamp: { requested: false, written: false, reason: 'not_elected' } })),
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
  (global as any).__mapProps = undefined;
  (global as any).__overview = overview();
  (global as any).__recs = [BANDED_REC, UNBANDED_REC];
});

async function mountAndCapture() {
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-map-card-stub')).toBeTruthy());
  await waitFor(() => expect((global as any).__mapProps?.envelope !== undefined).toBe(true));
  return (global as any).__mapProps;
}

test('the screen hands the map the certified envelope geometry off the overview', async () => {
  const props = await mountAndCapture();
  expect(props.envelope).toEqual(SAFE_ENVELOPE);
  // Both edges, because the map needs the difference between them: outside the
  // proved edge is a refusal, outside the planning edge is a flag.
  expect(props.envelope.radiusMetres).toBe(37_000);
  expect(props.envelope.plannedRadiusMetres).toBe(27_000);
  // Permanently false on this tree — being inside the disc certifies nothing.
  expect(props.envelope.certifiedInward).toBe(false);
});

test('a fallback airport with no envelope is handed null, not an unbounded one', async () => {
  (global as any).__overview = overview({ safeEnvelope: null });
  const props = await mountAndCapture();
  expect(props.envelope).toBeNull();
});

test('the pin bands are keyed by RECOMMENDATION id, from the recommendation contract', async () => {
  const props = await mountAndCapture();
  expect(Object.keys(props.candidateFeasibility)).toEqual(['rec-a']);
  expect(props.candidateFeasibility['rec-a'].withinPlannedEdge).toBe(false);
  expect(props.candidateFeasibility['rec-a'].plannedEdgeReason).toMatch(/held back/);
  // The stop that carries this id is the one the card will band.
  expect(props.stops[0].recommendationId).toBe('rec-a');
});

test('a card the server did not band contributes NO entry — an absence, not an empty band', async () => {
  const props = await mountAndCapture();
  // `rec-b` came back with no `feasibility`. A `?? {}` here would put a
  // band-shaped object with no band into the lookup, and the card would render
  // "measured" for something nothing measured.
  expect('rec-b' in props.candidateFeasibility).toBe(false);
});

test('the offline certification instants reach the map for the stale badge', async () => {
  const props = await mountAndCapture();
  // The bundle's own object, handed straight down: the card feeds it to
  // `bundleFreshness`, which is the ONE staleness rule on this client. A
  // re-shaped `{certifiedAt, staleAfter}` literal here would be a second place
  // that decides which fields staleness is made of.
  expect(props.offline.certifiedAt).toBe(CERTIFIED_AT);
  expect(props.offline.staleAfter).toBe(STALE_AFTER);
});
