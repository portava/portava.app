/**
 * census-layover L132 / L124 — THE WIRING HALF of the crew temporary location.
 *
 * `LayoverCrewLocationCard.component.test.tsx` proves the CARD reads
 * `GET /crew/location`, draws nothing while the capability is off, and hands
 * every read it lands to `onRead`. `LayoverMapCard.crewMembers.component.test.tsx`
 * proves the MAP draws whatever `crewLocations` it is given. Neither proves a
 * traveller ever sees either: until this screen mounted the card and passed its
 * read to the map, both were tested modules with no caller.
 *
 * This file pins the screen's part, with the card and the map CAPTURED rather
 * than rendered (their own suites own their rendering):
 *
 *   1. the card is MOUNTED, inside the exploration block, as the SIBLING right
 *      after `LayoverCrewSection` — not inside it. Inside, the card's own read
 *      would join the section's fetches and break the section's
 *      `toHaveBeenCalledTimes(2)` offline assertion;
 *   2. it is given the session, the airport's timezone, the SAME refresh key
 *      as the crew section, and an `onRead`;
 *   3. the map's `crewLocations` is exactly the crewmates of the card's last
 *      read when, and only when, that read says the capability is available
 *      and the traveller is in a crew. Feature off, no crew, or a failed read
 *      all hand the map `null`, including after an earlier read that had
 *      crewmates: a failed refresh must not keep stale positions on the map;
 *   4. at RETURN_NOW it collapses with the rest of exploration.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Removing the mount fails cases 1, 2 and 4b. Mounting it as a child of the
 * crew section fails case 1. Dropping `crewLocations`, or passing the crewmates
 * of a read that is not available+inCrew, fails case 3.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Every instant derives from `Date.now()` at module load.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
 * The card under wiring is CAPTURED: this file asserts on the props crossing
 * the boundary. Its real behaviour (feature off draws nothing, the share sheet,
 * the precise switch) is pinned in `LayoverCrewLocationCard.component.test.tsx`
 * against a fetch spy, and end to end through this screen in
 * `layoverDashboard.crewLocationFlag.component.test.tsx`.
 */
jest.mock('../../../src/components/layover/LayoverCrewLocationCard', () => {
  const { View } = require('react-native');
  return {
    LayoverCrewLocationCard: (props: any) => {
      (global as any).__crewLocationProps = props;
      return <View testID="layover-crew-location-stub" />;
    },
  };
});

/**
 * The crew section renders whatever children it is handed, so a card passed
 * INTO it would show up as its descendant and fail case 1.
 */
jest.mock('../../../src/components/layover/LayoverCrewSection', () => {
  const { View } = require('react-native');
  return {
    LayoverCrewSection: (props: any) => {
      (global as any).__crewSectionProps = props;
      return <View testID="layover-crew-section-stub">{props.children}</View>;
    },
  };
});

jest.mock('../../../src/components/layover/LayoverMapCard', () => {
  const { View } = require('react-native');
  return {
    LayoverMapCard: (props: any) => {
      (global as any).__mapProps = props;
      return <View testID="layover-map-card-stub" />;
    },
  };
});

// NOTE: intentional stubs — each pulls maps, plan, discovery or compass chains
// that have nothing to do with where this card is mounted.
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
jest.mock('../../../src/components/layover/LayoverFlightChangeCard', () => ({ LayoverFlightChangeCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name, so a spread of requireActual would drag `lib/supabase` and
// its native SecureStore adapter into the module graph.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ ok: true, city: 'Bangkok', buddies: [], refusal: null, safetyGate: null, trustRequirement: null, degraded: false, degradedReasons: [] })),
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
const ENDS = new Date(NOW + HOUR).toISOString();

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
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 237,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState, tier: 'long', tierLabel: 'Long layover',
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

/** A read as `parseCrewLocation` returns it: in a crew, one crewmate sharing. */
function inCrewRead() {
  return {
    ok: true as const, available: true as const, inCrew: true as const,
    crewId: 'crew-1', maxShareMinutes: 240, shareEndsBy: ENDS,
    preciseControl: { enabled: false }, mine: null, crewmatesWithheld: null,
    crewmates: [{
      userId: 'u-a', label: 'Night market', precision: 'venue' as const,
      sharedAt: new Date(NOW).toISOString(), endsAt: ENDS, position: null,
      ring: { center: { lat: 13.75, lng: 100.5 }, radiusMeters: 150 },
      proximity: 'close' as const, handle: 'ann', name: 'Ann',
    }],
  };
}

/** Depth-first: the testIDs of `rootId`'s nearest testID'd descendants, in order. */
function childTestIds(rootId: string): string[] {
  const out: string[] = [];
  let inside = false;
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return; }
    const id = node.props?.testID;
    if (inside && typeof id === 'string') { out.push(id); return; }
    if (id === rootId) {
      inside = true;
      (node.children ?? []).forEach((n: any) => walk(n, depth + 1));
      inside = false;
      return;
    }
    (node.children ?? []).forEach((n: any) => walk(n, depth + 1));
  };
  walk(screen.toJSON(), 0);
  return out;
}

async function mount(returnState = 'NORMAL') {
  (global as any).__crewLocationProps = undefined;
  (global as any).__crewSectionProps = undefined;
  (global as any).__mapProps = undefined;
  (global as any).__overview = overviewBody(returnState);
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());
}

describe('the layover dashboard mounts the crew location card (L132)', () => {
  it('1. MOUNTED in the exploration block, as the sibling right after the crew section, not inside it', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-stub')).toBeTruthy());
    const exploration = childTestIds('layover-exploration');
    const crewAt = exploration.indexOf('layover-crew-section-stub');
    expect(crewAt).toBeGreaterThanOrEqual(0);
    expect(exploration[crewAt + 1]).toBe('layover-crew-location-stub');
    // Not handed to the crew section as a child.
    expect(childTestIds('layover-crew-section-stub')).toEqual([]);
    expect((global as any).__crewSectionProps.children).toBeUndefined();
  });

  it('2. it is given the session, the airport timezone, the crew section\'s refresh key and an onRead', async () => {
    await mount();
    await waitFor(() => expect((global as any).__crewLocationProps).toBeTruthy());
    const props = (global as any).__crewLocationProps;
    expect(props.sessionId).toBe('sess-1');
    expect(props.timezone).toBe('Asia/Bangkok');
    expect(typeof props.refreshKey).toBe('number');
    expect(props.refreshKey).toBe((global as any).__crewSectionProps.refreshKey);
    expect(typeof props.onRead).toBe('function');
  });
});

describe('the map gets the crewmates of the card\'s read, and only an available in-crew read (L124)', () => {
  async function land(read: unknown) {
    await act(async () => { (global as any).__crewLocationProps.onRead(read); });
  }

  it('3a. before any read the map is told there is no crew element: null, not absent', async () => {
    await mount();
    await waitFor(() => expect((global as any).__mapProps).toBeTruthy());
    expect('crewLocations' in (global as any).__mapProps).toBe(true);
    expect((global as any).__mapProps.crewLocations).toBeNull();
  });

  it('3b. an available, in-crew read hands the map exactly its crewmates', async () => {
    await mount();
    await waitFor(() => expect((global as any).__crewLocationProps).toBeTruthy());
    const read = inCrewRead();
    await land(read);
    await waitFor(() => expect((global as any).__mapProps.crewLocations).toBe(read.crewmates));
  });

  it.each([
    ['the capability is off', { ok: true, available: false }],
    ['the traveller is in no crew', { ok: true, available: true, inCrew: false }],
    ['the read failed', { ok: false, reason: 'unreachable', message: 'Could not reach Portava to load crew locations.' }],
  ])('3c. %s: the map gets null, and a failed refresh clears crewmates an earlier read had', async (_label, read) => {
    await mount();
    await waitFor(() => expect((global as any).__crewLocationProps).toBeTruthy());
    await land(inCrewRead());
    await waitFor(() => expect((global as any).__mapProps.crewLocations).toHaveLength(1));
    await land(read);
    await waitFor(() => expect((global as any).__mapProps.crewLocations).toBeNull());
  });
});

describe('the certified posture collapses it with the rest of exploration', () => {
  it('4a. at RETURN_NOW the card is not mounted', async () => {
    await mount('RETURN_NOW');
    await waitFor(() => expect(screen.getByTestId('layover-exploration-collapsed')).toBeTruthy());
    expect(screen.queryByTestId('layover-crew-location-stub')).toBeNull();
  });

  it('4b. "Show them anyway" brings it back beside the crew section', async () => {
    await mount('RETURN_NOW');
    await waitFor(() => expect(screen.getByTestId('layover-exploration-show-anyway')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-exploration-show-anyway'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-stub')).toBeTruthy());
  });
});
