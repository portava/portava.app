/**
 * census-layover L150 — THE WIRING HALF: the deadline actually survives.
 *
 * `layoverDeadlineCache.component.test.tsx` proves the store is honest. This
 * file proves the SCREEN uses it, which is the requirement: §16 asks that the
 * latest certified return deadline and its snapshot timestamp be PERSISTED FOR
 * DISPLAY, and before this the layover client made no AsyncStorage write at
 * all. A traveller who lost signal in the city got
 * "We couldn't reach Portava" and NOTHING ELSE — no return time, on the one
 * screen whose entire job is to get them back to a plane.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 1 fails if nothing is written on a successful load. Case 2 fails if the
 * screen has the record and does not show it. Case 3 is the one that stops the
 * feature being bought with a lie: a cached deadline is rendered as LAST
 * CERTIFIED with its age, never as "Be back by" — so a fix that made the card
 * render by relaxing the staleness bound fails here rather than looking like a
 * success.
 *
 * Case 4 is the control in the other direction: for a layover the server says
 * is GONE, a cached deadline must NOT appear. The session does not exist; its
 * return time is not a fact any more, and showing one would send someone to an
 * airport for a flight that is not theirs.
 *
 * Case 5: with nothing cached, the failure screen is exactly what it was. An
 * absent cache must render as absent, never as a placeholder time.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Every instant derives from `Date.now()` at module load, and the staleness
 * offsets are relative to the fixture's own `certifiedAt`. Nothing expires.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LayoverDashboardScreen from '../[id].tsx';
import {
  cacheCertifiedDeadline,
  readCachedDeadline,
} from '../../../src/components/layover/layoverDeadlineCache.ts';

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
// file is about a persisted deadline, not about scheduling.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — each pulls maps, plan, crew or compass chains with
// nothing to do with the cached deadline.
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
// NOTE: intentional stub — see above. The SafeReturnCard renders the LIVE
// deadline; this file is about the one shown when there is no live answer.
jest.mock('../../../src/components/layover/LayoverSafeReturnCard', () => ({ LayoverSafeReturnCard: () => null }));

// NOTE: intentional stub, and deliberately exhaustive — the screen imports each
// of these by name, so a requireActual spread would drag `lib/supabase` and its
// native SecureStore adapter into the module graph.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__ovRead),
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

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.now();
/**
 * The bundle is certified 90 MINUTES AGO on purpose. The server's TTL is 15
 * minutes, so anything read out of this cache is comfortably past `staleAfter`
 * — which is the realistic case (a cache is read when the network has been
 * gone a while) and the one case 3 needs.
 */
const CERTIFIED_AT = new Date(NOW - 90 * MIN).toISOString();
const STALE_AFTER = new Date(NOW - 75 * MIN).toISOString();
const HARD_RETURN = new Date(NOW + 2 * HOUR).toISOString();

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
      id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
      countryCode: 'TH', timezone: 'Asia/Bangkok', lat: 13.69, lng: 100.75, verified: true,
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
    safeEnvelope: null,
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
        iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
        timezone: 'Asia/Bangkok', lat: 13.69, lng: 100.75, terminalInfo: null,
      },
      mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
      route: { available: false, value: null, reason: 'no_routing_provider' },
      flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
      crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
      translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
      stops: [],
    },
    returnReminderAt: null,
    localTimes: {
      timezone: 'Asia/Bangkok', airportNow: '12:00', airportToday: '2026-01-01',
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
  const view = await render(<LayoverDashboardScreen />);
  return view;
}

/**
 * Put a record in the store exactly as a successful load does — through the
 * SAME `cacheCertifiedDeadline` the screen calls, on the SAME bundle the
 * fixture's overview carries.
 *
 * WHY NOT MOUNT TWICE. Case 1 already pins that a successful load performs this
 * write, so mounting the screen again here would re-prove that and nothing
 * else. It would also put two `render()` trees inside one test, which on
 * React 19 + RNTL v14 corrupts `actScopeDepth` for every test after it — the
 * interaction `src/jest.setup.ts` documents at length. Case 1 owns the write,
 * cases 2-4 own the read and the rendering, and between them the round trip is
 * covered without that hazard.
 */
async function seedFromASuccessfulLoad() {
  const wrote = await cacheCertifiedDeadline('sess-1', overviewBody().offlineBundle as never);
  expect(wrote).toBe(true);
  expect(await readCachedDeadline('sess-1')).not.toBeNull();
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('§16 L150 — the certified deadline is persisted, and it is what the traveller keeps', () => {
  it('1. a successful load WRITES the certified deadline and its snapshot timestamps', async () => {
    const view = await mount({ ok: true, overview: overviewBody() });
    await waitFor(() => expect(screen.getByTestId('layover-hero-stub')).toBeTruthy());

    await waitFor(async () => {
      const rec = await readCachedDeadline('sess-1');
      expect(rec).not.toBeNull();
    });
    const rec = await readCachedDeadline('sess-1');
    expect(rec!.hardReturnTime).toBe(HARD_RETURN);
    expect(rec!.certifiedAt).toBe(CERTIFIED_AT);
    // Verbatim: the screen does not get to renew the server's bound on the way
    // into storage.
    expect(rec!.staleAfter).toBe(STALE_AFTER);
    view.unmount();
  });

  it('2. when the server cannot be reached, the cached deadline is on screen', async () => {
    await seedFromASuccessfulLoad();
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    // The one number that must survive everything else going dark.
    await waitFor(() => expect(screen.getByTestId('layover-cached-deadline')).toBeTruthy());
    // The server's refusal sentence is still there — the cache adds to it, it
    // does not replace it or pretend the load worked.
    expect(screen.getByText(UNREACHABLE.message)).toBeTruthy();
  });

  it('3. the cached deadline is labelled LAST CERTIFIED with its age, never as live truth', async () => {
    await seedFromASuccessfulLoad();
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-cached-deadline')).toBeTruthy());

    // The fixture is 90 minutes past `certifiedAt` and 75 past `staleAfter`, so
    // the staleness caption MUST have fired. A build that relaxed the bound to
    // make this card look better fails here.
    // The AGE, not just the label — "Last certified return time" would be on
    // screen even for a live bundle if the label alone were asserted.
    expect(screen.getByText(/Last certified \d+ min ago/i)).toBeTruthy();
    expect(screen.getByTestId('layover-cached-deadline-staleness')).toBeTruthy();
    // And it must not be captioned as current.
    expect(screen.queryByText('Be back by')).toBeNull();
    expect(screen.getByText('Last certified return time')).toBeTruthy();
  });

  it('4. for a layover the server says is GONE, no cached deadline is shown', async () => {
    await seedFromASuccessfulLoad();
    await mount(GONE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    // The session does not exist. Its return time is not a fact any more, and
    // a cache is not a reason to send someone to an airport.
    expect(screen.queryByTestId('layover-cached-deadline')).toBeNull();
  });

  it('5. with nothing cached, the failure screen is exactly what it was — no placeholder time', async () => {
    await mount(UNREACHABLE);
    await waitFor(() => expect(screen.getByTestId('layover-load-error')).toBeTruthy());
    expect(screen.queryByTestId('layover-cached-deadline')).toBeNull();
    expect(screen.getByText(UNREACHABLE.message)).toBeTruthy();
  });
});
