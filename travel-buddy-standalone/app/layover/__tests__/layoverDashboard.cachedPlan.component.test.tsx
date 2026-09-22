/**
 * census-layover L233 and L151 — THE WIRING HALF: the plan survives too.
 *
 * `src/lib/__tests__/layoverPlanCache.component.test.ts` proves the store is
 * honest. This file proves the SCREEN uses it.
 *
 * L150 closed the deadline: a traveller who lost signal kept the one number
 * that gets them back to a plane. They kept NOTHING ELSE. L233 asks that the
 * cached return PLAN stay visible with a stale indicator, and L151 that the
 * airport and the certified area be cached for the map surface — and on this
 * tree the failure screen showed a refusal sentence, a return time, and a
 * Try-again button. Where the traveller was going, and how far out the
 * certified envelope reached, both died with the network.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 1 fails if a successful load writes no plan. Case 2 fails if the screen
 * has the record and does not render it. Case 3 is the one that stops the
 * feature being bought with a lie: the block must be captioned LAST CERTIFIED
 * with its age, and the envelope must never be rendered as a promise that
 * anything inside it fits — `certifiedInward` is false for every envelope this
 * tree emits. Case 4 is the control in the other direction: for a layover the
 * server says is GONE, no cached plan appears at all. Case 5: with nothing
 * cached, the failure screen is exactly what it was.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Every instant derives from `Date.now()` at module load. Nothing expires.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LayoverDashboardScreen from '../[id].tsx';
import { cacheCertifiedPlan, readCachedPlan } from '../../../src/lib/layoverPlanCache.ts';

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
// file is about a persisted plan, not about scheduling.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — each pulls maps, plan, crew or compass chains with
// nothing to do with the cached plan. The OFFLINE card is deliberately NOT
// stubbed: it is the thing under test.
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
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverDiscoveryCard', () => ({ LayoverDiscoveryCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverSafeReturnCard', () => ({ LayoverSafeReturnCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name, so a requireActual spread would drag `lib/supabase` and its
// native SecureStore adapter into the module graph.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__ovRead),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Istanbul', buddies: [] })),
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

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.now();
/** 90 minutes old against a 15-minute server TTL: comfortably stale, which is
 *  the realistic state of any cache that is read at all. */
const CERTIFIED_AT = new Date(NOW - 90 * MIN).toISOString();
const STALE_AFTER = new Date(NOW - 75 * MIN).toISOString();
const HARD_RETURN = new Date(NOW + 2 * HOUR).toISOString();

const BUNDLE_STOPS = [
  { title: 'Blue Mosque', durationMin: 60, travelMin: 45, insideAirport: false },
  { title: 'Airport lounge', durationMin: 30, travelMin: 0, insideAirport: true },
];

const ENVELOPE = {
  centre: { lat: 41.2753, lng: 28.7519 },
  radiusMetres: 42_000,
  usableMinutes: 240,
  maxOneWayMinutes: 60,
  basis: 'straight_line_lower_bound',
  certifiedOutward: true,
  certifiedInward: false,
  confidence: 'LOW',
  uncertaintyBudgetMinutes: 20,
  plannedMaxOneWayMinutes: 45,
  plannedRadiusMetres: 31_000,
};

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
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
      status: 'active', createdAt: new Date(NOW - HOUR).toISOString(),
    },
    airport: {
      id: 'ap-1', iataCode: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'Türkiye',
      countryCode: 'TR', timezone: 'Europe/Istanbul', lat: 41.2753, lng: 28.7519, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 240,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState: 'NORMAL', tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: CERTIFIED_AT, verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 240, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    safeReturn: { returnState: 'NORMAL', explorationCollapsed: false, returnRoutePrimary: false, minutesToHardReturn: 120, abortAvailable: true },
    safeEnvelope: ENVELOPE,
    offlineBundle: {
      bundleVersion: '2026.09.08-1',
      sessionId: 'sess-1',
      certifiedAt: CERTIFIED_AT,
      staleAfter: STALE_AFTER,
      certification: {
        engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
        computedAt: CERTIFIED_AT, verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
      },
      returnDeadline: {
        hardReturnTime: HARD_RETURN, hardReturnLocal: '20:40',
        returnState: 'NORMAL', bufferMinutes: 120, returnReminderAt: null,
      },
      airport: {
        iataCode: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'Türkiye',
        timezone: 'Europe/Istanbul', lat: 41.2753, lng: 28.7519, terminalInfo: null,
      },
      mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
      route: { available: false, value: null, reason: 'no_routing_provider' },
      flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
      crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
      translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
      stops: BUNDLE_STOPS,
    },
    returnReminderAt: null,
    localTimes: {
      timezone: 'Europe/Istanbul', airportNow: '12:00', airportToday: '2026-01-01',
      arrivalLocal: '11:00', arrivalDay: '2026-01-01',
      departureLocal: '18:00', departureDay: '2026-01-01',
    },
  };
}

const UNREACHABLE = {
  ok: false, reason: 'unreachable',
  message: "We couldn't reach Portava. Check your connection and try again.",
  retryable: true,
};
const GONE = {
  ok: false, reason: 'gone',
  message: 'It may have been removed, or it belongs to another account.',
  retryable: false,
};

async function mount(ovRead: unknown) {
  (global as any).__ovRead = ovRead;
  return render(<LayoverDashboardScreen />);
}

/**
 * Seed through the SAME writer the screen calls, on the SAME bundle and
 * envelope the fixture's overview carries. Case 1 owns the proof that a
 * successful load performs this write; mounting twice inside one test corrupts
 * RNTL's act scope (see `src/jest.setup.ts`), so the rest read what it wrote.
 */
async function seedFromASuccessfulLoad() {
  const body = overviewBody();
  const wrote = await cacheCertifiedPlan('sess-1', body.offlineBundle as never, body.safeEnvelope as never);
  expect(wrote).toBe(true);
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('§16 L151 / §20 L233 — the plan and the certified area survive the network', () => {
  it('1. a successful load WRITES the plan, the airport and the certified area', async () => {
    const view = await mount({ ok: true, overview: overviewBody() });
    await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());

    await waitFor(async () => {
      expect(await readCachedPlan('sess-1')).not.toBeNull();
    });
    const rec = await readCachedPlan('sess-1');
    expect(rec!.stops.map((s) => s.title)).toEqual(['Blue Mosque', 'Airport lounge']);
    expect(rec!.airport.iataCode).toBe('IST');
    expect(rec!.envelope!.radiusMetres).toBe(42_000);
    // Verbatim: the screen does not renew the server's bound on the way in.
    expect(rec!.staleAfter).toBe(STALE_AFTER);
    view.unmount();
  });

  it('2. when the server cannot be reached, the cached plan is on screen', async () => {
    await seedFromASuccessfulLoad();
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('layover-cached-plan')).toBeTruthy());

    // Where they were going — the whole point of L233.
    expect(screen.getByText(/Blue Mosque/)).toBeTruthy();
    expect(screen.getByText(/Airport lounge/)).toBeTruthy();
    // L151 — the airport, cached.
    expect(screen.getByTestId('layover-cached-plan-airport')).toBeTruthy();
    expect(screen.getByText(/IST/)).toBeTruthy();
    // The server's refusal sentence is still there: the cache adds to it and
    // never replaces it or implies the load worked.
    expect(screen.getByText(UNREACHABLE.message)).toBeTruthy();
  });

  it('3. it is captioned LAST CERTIFIED with its age, and the envelope promises nothing', async () => {
    await seedFromASuccessfulLoad();
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-cached-plan')).toBeTruthy());

    // The fixture is 75 minutes past `staleAfter`, so the indicator MUST fire.
    // A build that relaxed the bound to make this look better fails here.
    expect(screen.getByTestId('layover-cached-plan-staleness')).toBeTruthy();
    expect(screen.getByText(/Last certified \d+ min ago/i)).toBeTruthy();

    // L151's area half, and the one sentence it may never say. `certifiedInward`
    // is false for every envelope this tree emits: inside the disc is NOT a
    // certification that anything fits.
    const area = screen.getByTestId('layover-cached-plan-envelope');
    expect(area).toBeTruthy();
    expect(screen.getByText(/42 km/)).toBeTruthy();
    expect(screen.queryByText(/\bsafe to\b/i)).toBeNull();
  });

  it('4. for a layover the server says is GONE, no cached plan is shown', async () => {
    await seedFromASuccessfulLoad();
    await mount(GONE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    // The session is not this traveller's any more. Its plan is not a fact.
    expect(screen.queryByTestId('layover-cached-plan')).toBeNull();
  });

  it('5. with nothing cached, the failure screen is exactly what it was', async () => {
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    expect(screen.queryByTestId('layover-cached-plan')).toBeNull();
    expect(screen.getByText(UNREACHABLE.message)).toBeTruthy();
  });
});
