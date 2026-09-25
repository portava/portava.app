/**
 * census-layover L269 — THE WIRING HALF.
 *
 * `LayoverDiscoveryCard.component.test.tsx` proves the CARD reaches
 * `/api/hidden-gems/layover-safe` and renders each of its four answers. This
 * file proves the SCREEN MOUNTS IT — which is the whole of L269's finding:
 * `getLayoverGems` and the route behind it have existed for several census
 * passes with no caller anywhere under `app/layover/`. A correct card that no
 * screen renders is the same defect one level up, and
 * `layover_discovery_mode_enabled` would still have nothing to turn on.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 1 fails if the card is not mounted at all. Case 2 fails if it is mounted
 * with a locally-derived number instead of the server's certified
 * `window.usableMinutes` — the value is asserted to be that exact figure, and
 * the fixture's window deliberately does not equal any clock subtraction this
 * screen could make. Case 3 fails if the card is hoisted out of the exploration
 * block: at RETURN_NOW the certified posture collapses exploration, and an
 * invitation to leave the airport must collapse with it rather than outlive it.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Every instant derives from `Date.now()` at module load. `usableMinutes` is a
 * fixture CONSTANT, not a span between two of them, precisely so that case 2
 * can tell "passed the server's figure" from "recomputed a plausible one".
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
// file is about which cards are mounted, not about scheduling.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

/**
 * The Discovery card is stubbed so this file asserts on the PROPS crossing the
 * boundary rather than on a second copy of the card's own rendering. Its real
 * behaviour — including the gate-off case, which renders nothing — is pinned in
 * `LayoverDiscoveryCard.component.test.tsx` against a fetch spy.
 */
jest.mock('../../../src/components/layover/LayoverDiscoveryCard', () => {
  const { View } = require('react-native');
  return {
    LayoverDiscoveryCard: (props: any) => {
      (global as any).__discoveryProps = props;
      return <View testID="layover-discovery-stub" />;
    },
  };
});

// NOTE: intentional stubs — each pulls maps, plan, crew or compass chains that
// have nothing to do with which cards this screen mounts.
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
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCrewSection', () => ({ LayoverCrewSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name, so a spread of requireActual would drag `lib/supabase` and
// its native SecureStore adapter into the module graph. The service's own
// parsing is exercised against a fetch spy in the card suites.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Bangkok', buddies: [] })),
  getLayoverPresence: jest.fn(async () => null),
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

/**
 * 237 is a CONSTANT, not a span. The window below runs 7 hours with a 60-minute
 * exit delay and a 120-minute buffer, so no subtraction this screen could
 * perform yields 237 — which is what makes case 2 an assertion about provenance
 * rather than about arithmetic.
 */
const CERTIFIED_USABLE_MINUTES = 237;

function overviewBody(returnState: string) {
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
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120,
      usableMinutes: CERTIFIED_USABLE_MINUTES,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState, tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: CERTIFIED_USABLE_MINUTES, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    // `explorationCollapsed` is the SERVER's, from `safeReturnPosture`. Case 3
    // sets it rather than inferring it from the state, because that is the field
    // the screen actually keys on.
    safeReturn: {
      returnState,
      explorationCollapsed: returnState === 'RETURN_NOW',
      returnRoutePrimary: returnState === 'RETURN_NOW',
      minutesToHardReturn: 42,
      abortAvailable: true,
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

async function mount(returnState = 'NORMAL') {
  (global as any).__discoveryProps = undefined;
  (global as any).__overview = overviewBody(returnState);
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
}

describe('the layover dashboard is the Discovery consumer L269 asks for', () => {
  it('1. the Discovery card is MOUNTED — the endpoint finally has a caller under app/layover/', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-discovery-stub')).toBeTruthy());
  });

  it('2. it is handed the SERVER\'s certified usable minutes, not a locally derived figure', async () => {
    await mount();
    await waitFor(() => expect((global as any).__discoveryProps).toBeTruthy());
    const props = (global as any).__discoveryProps;
    expect(props.availableMinutes).toBe(CERTIFIED_USABLE_MINUTES);
    expect(props.city).toBe('Bangkok');
  });

  it('3. at RETURN_NOW it collapses with the rest of exploration, as the certified posture says', async () => {
    await mount('RETURN_NOW');
    await waitFor(() => expect(screen.getByTestId('layover-exploration-collapsed')).toBeTruthy());
    // An invitation to leave the airport must not outlive the posture that
    // collapsed the rest of exploration.
    expect(screen.queryByTestId('layover-discovery-stub')).toBeNull();
  });
});
