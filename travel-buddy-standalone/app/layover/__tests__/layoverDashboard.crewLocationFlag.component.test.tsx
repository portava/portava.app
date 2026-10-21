/**
 * census-layover L132 / L124 — the crew location card ON THE SCREEN, end to
 * end, against a fetch spy. `layoverDashboard.crewLocation.component.test.tsx`
 * pins the wiring with the card captured; this file runs the REAL card under
 * the real screen, because the case that matters most today is the quiet one.
 *
 * `layover_crew_location_enabled` is seeded FALSE, and until the router is
 * mounted the route does not exist at all. In both states a traveller opening
 * their layover must see NOTHING of this feature: no heading, no switch, no
 * "unavailable" line, no error. Sibling cards hold the same rule
 * (`LayoverDiscoveryCard` renders null on `gated_off`). And a read that FAILED
 * before the server ever said the feature is on and the traveller is in a crew
 * is not a reason to draw it either, or every offline traveller would be told
 * about a capability they do not have.
 *
 *   1. feature off (200 `{ available: false }`): the card asks, then draws nothing;
 *   2. route absent or refused as off (404): nothing;
 *   3. a failed first read (503, or fetch rejecting offline): nothing;
 *   4. in a crew, feature on: the card draws, and the map gets the crewmates.
 *
 * Only `fetch` and the two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

import LayoverDashboardScreen from '../[id].tsx';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../src/lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

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

// NOTE: intentional stub — expo-notifications needs a native runtime.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// The map is CAPTURED: what it draws from `crewLocations` is
// `LayoverMapCard.crewMembers.component.test.tsx`'s job.
jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return {
    LayoverMapCard: (props: any) => {
      (global as any).__mapProps = props;
      return <View testID="layover-map-card-stub" />;
    },
  };
});

// NOTE: intentional stubs — none of them is under test here, and each one that
// fetches on mount would add its own calls to the spy below.
jest.mock('../../../src/components/layover/LayoverHero', () => {
  const { View } = require('react-native');
  return { LayoverHero: () => <View testID="layover-hero-stub" /> };
});
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/CanILeaveCard', () => ({ CanILeaveCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverConstraintsCard', () => ({ LayoverConstraintsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportEssentialsCard', () => ({ AirportEssentialsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/AirportConditionsCard', () => ({ AirportConditionsCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPlanSection', () => ({ LayoverPlanSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverDiscoveryCard', () => ({ LayoverDiscoveryCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name. The crew location card reads through its OWN service
// (`services/layoverCrewLocation.ts`), which is left real and meets the spy.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ ok: true, city: 'Bangkok', buddies: [], refusal: null, safetyGate: null, trustRequirement: null, degraded: false, degradedReasons: [] })),
  getLayoverPresence: jest.fn(async () => null),
  getLayoverDiscovery: jest.fn(async () => ({ ok: true, gems: [] })),
  getPlanStops: jest.fn(async () => ({ stops: [], planFit: null })),
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
const ENDS = new Date(NOW + HOUR).toISOString();

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
      canonicalCityId: null, shareCityStatus: false,
      returnReminderAt: null,
      status: 'active', createdAt: new Date(NOW - HOUR).toISOString(),
    },
    airport: {
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
      countryCode: 'TH', timezone: 'Asia/Bangkok', lat: 13.69, lng: 100.75, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 237,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: new Date(NOW + 4 * HOUR).toISOString(),
      returnState: 'NORMAL', tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 237, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    safeReturn: {
      returnState: 'NORMAL', explorationCollapsed: false, returnRoutePrimary: false,
      minutesToHardReturn: 42, abortAvailable: true,
    },
    safeEnvelope: null, offlineBundle: null,
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '12:00', airportToday: '2026-01-01',
      arrivalLocal: '11:00', arrivalDay: '2026-01-01',
      departureLocal: '18:00', departureDay: '2026-01-01',
    },
  };
}

function inCrewBody() {
  return {
    ok: true, available: true, inCrew: true, crewId: 'crew-1', maxShareMinutes: 240, shareEndsBy: ENDS,
    preciseControl: { enabled: false }, mine: null, crewmatesWithheld: null,
    crewmates: [{
      userId: 'u-a', label: 'Night market', precision: 'venue', purpose: 'presence_in_context',
      sharedAt: new Date(NOW).toISOString(), endsAt: ENDS, position: null,
      ring: { center: { lat: 13.75, lng: 100.5 }, radiusMeters: 150 }, proximity: 'close', handle: 'ann', name: 'Ann',
    }],
  };
}

type Answer = { status: number; body: unknown } | 'offline';

/**
 * Every fetch the screen makes reaches this spy; only the crew location GET gets
 * the scenario's answer. Other dashboard cards' reads are answered as switched
 * off, so their own refusal copy cannot be mistaken for the crew card's. `landed`
 * flips once the crew read has had its body parsed (or its fetch rejected), so a
 * test can tell "drew nothing" from "has not asked yet".
 */
function spy(answer: Answer) {
  const seen: string[] = [];
  const state = { landed: false };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (!url.endsWith('/crew/location')) return { ok: false, status: 404, json: async () => ({ ok: false, reason: 'feature_disabled' }) } as unknown as Response;
    if (answer === 'offline') { state.landed = true; throw new TypeError('Network request failed'); }
    const { status, body } = answer;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => { state.landed = true; return body; },
    } as unknown as Response;
  });
  return { seen, state };
}

async function mountAndLand(answer: Answer) {
  (global as any).__mapProps = undefined;
  (global as any).__overview = overviewBody();
  const { seen, state } = spy(answer);
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
  // The card ASKED, for this session — so "nothing drawn" below is an answer
  // to a read, not a card that was never mounted.
  await waitFor(() => expect(state.landed).toBe(true));
  await act(async () => { await Promise.resolve(); });
  expect(seen.some((s) => s.startsWith('GET ') && s.endsWith('/api/airport/sessions/sess-1/crew/location'))).toBe(true);
  return seen;
}

function expectNothingDrawn() {
  expect(screen.queryByTestId('layover-crew-location')).toBeNull();
  expect(screen.queryByTestId('layover-crew-location-unavailable')).toBeNull();
  expect(screen.queryByText(/Where the crew is/)).toBeNull();
  expect(screen.queryByText(/[Cc]rew locations?/)).toBeNull();
  expect(screen.queryByText(/could not|couldn't|unavailable|error/i)).toBeNull();
  expect((global as any).__mapProps.crewLocations).toBeNull();
}

afterEach(() => { jest.restoreAllMocks(); });

describe('while the feature is off or absent, the screen shows nothing of it', () => {
  it('1. feature off — 200 { available: false }: the card asks, then draws nothing', async () => {
    await mountAndLand({ status: 200, body: { ok: true, available: false } });
    expectNothingDrawn();
  });

  it.each([
    ['the route is not mounted', { error: 'not_found' }],
    ['the route refuses it as off', { error: 'feature_disabled' }],
  ])('2. 404 — %s: nothing', async (_label, body) => {
    await mountAndLand({ status: 404, body });
    expectNothingDrawn();
  });

  it('3a. a failed FIRST read (503) is not a reason to draw a feature the server never said was on', async () => {
    await mountAndLand({ status: 503, body: { error: 'degraded_unavailable', message: 'x' } });
    expectNothingDrawn();
  });

  it('3b. offline (fetch rejects) on the first read: nothing', async () => {
    await mountAndLand('offline');
    expectNothingDrawn();
  });
});

describe('with the feature on and the traveller in a crew', () => {
  it('4. the card draws beside the crew, and the map gets the same crewmates', async () => {
    const seen = await mountAndLand({ status: 200, body: inCrewBody() });
    await waitFor(() => expect(screen.getByTestId('layover-crew-location')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-location-mate-u-a')).toBeTruthy();
    await waitFor(() => expect((global as any).__mapProps.crewLocations?.map((c: any) => c.userId)).toEqual(['u-a']));
    // One read feeds both: the map does not make a second one.
    expect(seen.filter((s) => s.endsWith('/crew/location'))).toHaveLength(1);
  });
});
