/**
 * The dashboard schedules the certified return alerts — census-layover L41 /
 * L18 / L99 / L272, the lead's 2026-10-06 delivery ruling — and says what the
 * phone actually holds.
 *
 * Driven through the real screen: the overview's offline bundle carries the
 * certified hard return time, and the cases assert what reached
 * `scheduleLocalNotificationAt` (both instants, or nothing) and the sentence
 * on screen. The permission is only ever READ here; a traveller who has not
 * been asked gets a "Turn on" control that goes through the same rationale
 * flow as "Remind me".
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LayoverDashboardScreen from '../[id].tsx';
import { returnAlertsKey } from '../../../src/components/layover/layoverReturnAlerts';

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

// NOTE: intentional stub — expo-notifications needs a native runtime. This
// file IS about scheduling, so every entry point the return alerts use is a
// recording mock: the permission READ (never a request), schedule and cancel.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
  getPermissionsAsync: jest.fn(async () => ({})),
}));

// NOTE: intentional stubs — each pulls maps, discovery or presence chains that
// have nothing to do with the reminder banner.
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
jest.mock('../../../src/components/layover/LayoverRecsSection', () => ({ LayoverRecsSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverMapCard', () => ({ LayoverMapCard: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverPeopleSection', () => ({ LayoverPeopleSection: () => null }));
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));

// NOTE: intentional stub — the screen only needs data to render here; the real
// service is exercised against a fetch spy in the card suites.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => ({ ok: true, overview: (global as any).__overview })),
  getRecommendations: jest.fn(async () => ({ ok: true, recommendations: [] })),
  getLayoverBuddies: jest.fn(async () => ({ ok: true, city: 'Taipei', buddies: [], refusal: null, safetyGate: null, trustRequirement: null, degraded: false, degradedReasons: [] })),
  getLayoverPresence: jest.fn(async () => ({ sharing: false, count: 0, travelers: [] })),
  // census L269 — the screen mounts LayoverDiscoveryCard, which reads through
  // this module. Kept in step with the exhaustive list above: an omission here
  // does not fail as a missing card, it throws inside the render.
  getLayoverDiscovery: jest.fn(async () => ({ ok: true, gems: [] })),
  addStopFromRecommendation: jest.fn(async () => null),
  endLayoverSession: jest.fn(async () => ({ ok: true, outcome: 'cancelled', passportStamp: { requested: false, written: false, reason: 'not_elected' } })),
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

const HOUR = 3_600_000;
const NOW = Date.now();
const HARD_RETURN = new Date(NOW + 4 * HOUR).toISOString();

function overviewBody(reminder: Record<string, unknown> | undefined) {
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
      returnReminderAt: new Date(NOW + 2 * HOUR).toISOString(),
      status: 'active', createdAt: new Date(NOW - HOUR).toISOString(),
    },
    airport: {
      id: 'ap-1', iataCode: 'TPE', name: 'Taoyuan', city: 'Taipei', country: 'Taiwan',
      countryCode: 'TW', timezone: 'Asia/Taipei', lat: 25.07, lng: 121.23, verified: true,
    },
    window: {
      totalMinutes: 420, exitDelayMin: 60, returnBufferMin: 120, usableMinutes: 240,
      earliestOutTime: new Date(NOW).toISOString(), hardReturnTime: HARD_RETURN,
      returnState: 'NORMAL', tier: 'long', tierLabel: 'Long layover',
    },
    advice: { verdict: 'yes', reasons: [], unknowns: [], reasonCodes: [], disclaimer: '', engineVersion: 'v' },
    certification: {
      engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h',
      computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90',
    },
    estimates: {}, airportIntelligence: null, stops: [],
    planFit: { fits: 'fits', neededMin: 0, usableMinutes: 240, overflowMin: 0, unstatedTravelStops: 0, neededMinIsLowerBound: false },
    share: { enabled: false, othersInCity: 0 },
    safeReturn: { returnState: 'NORMAL', hardReturnTime: HARD_RETURN, notification: null },
    safeEnvelope: null, offlineBundle: (global as any).__bundle ?? null,
    returnReminderAt: new Date(NOW + 2 * HOUR).toISOString(),
    ...(reminder === undefined ? {} : { reminder }),
    localTimes: {
      timezone: 'Asia/Taipei', airportNow: '20:00', airportToday: '2026-09-14',
      arrivalLocal: '19:00', arrivalDay: '2026-09-14',
      departureLocal: '02:00', departureDay: '2026-09-15',
    },
  };
}


const notifications = require('../../../src/lib/safeNotifications');
const layoverService = require('../../../src/services/layover');

function bundle() {
  return {
    bundleVersion: 'v1', sessionId: 'sess-1',
    certifiedAt: new Date(NOW).toISOString(), staleAfter: new Date(NOW + HOUR).toISOString(),
    certification: { engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h', computedAt: new Date(NOW).toISOString(), verdict: 'yes', confidence: 'LOW', bufferPercentile: 'p90' },
    returnDeadline: { hardReturnTime: HARD_RETURN, hardReturnLocal: '00:00', returnState: 'NORMAL', bufferMinutes: 120, returnReminderAt: null },
    airport: { iataCode: 'TPE', name: 'Taoyuan', city: 'Taipei', country: 'Taiwan', timezone: 'Asia/Taipei', lat: 25.07, lng: 121.23, terminalInfo: null },
    mapGeometry: { available: false, reason: 'no_envelope_geometry' },
    route: { available: false, reason: 'no_routing_provider' },
    flightStatus: { available: false, reason: 'no_flight_feed' },
    crewMeetingPoint: { available: false, reason: 'no_crew' },
    translationPhrases: { available: false, reason: 'no_phrase_catalogue' },
    stops: [],
  };
}

async function mountWith(perms: Record<string, unknown>) {
  notifications.getPermissionsAsync.mockResolvedValue(perms);
  notifications.scheduleLocalNotificationAt.mockClear();
  notifications.scheduleLocalNotificationAt.mockImplementation(async () => `notif-${notifications.scheduleLocalNotificationAt.mock.calls.length}`);
  await AsyncStorage.clear();
  (global as any).__bundle = bundle();
  (global as any).__overview = overviewBody(undefined);
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
}

describe('return alerts on the dashboard', () => {
  afterEach(() => { (global as any).__bundle = undefined; });

  it('with notifications allowed, RETURN_SOON and RETURN_NOW are scheduled at the certified instants and named', async () => {
    await mountWith({ granted: true, status: 'granted' });
    await waitFor(() => expect(notifications.scheduleLocalNotificationAt).toHaveBeenCalledTimes(2));
    const at = notifications.scheduleLocalNotificationAt.mock.calls.map((c: [Date]) => c[0].toISOString());
    expect(at).toEqual([new Date(Date.parse(HARD_RETURN) - 30 * 60_000).toISOString(), HARD_RETURN]);
    await waitFor(() => expect(screen.getByTestId('layover-return-alerts-text')).toBeTruthy());
    expect(String((screen.getByTestId('layover-return-alerts-text').props as { children: unknown }).children)).toMatch(/^Return alerts on: /);
    expect(screen.queryByTestId('layover-return-alerts-enable')).toBeNull();
  });

  it('a DENIED permission schedules nothing and says notifications are not allowed', async () => {
    await mountWith({ granted: false, status: 'denied' });
    await waitFor(() => expect(screen.getByTestId('layover-return-alerts-text')).toBeTruthy());
    expect(String((screen.getByTestId('layover-return-alerts-text').props as { children: unknown }).children)).toMatch(/not allowed/);
    expect(notifications.scheduleLocalNotificationAt).not.toHaveBeenCalled();
    expect(screen.queryByTestId('layover-return-alerts-enable')).toBeNull();
  });

  it('a traveller nobody has asked is offered "Turn on", which goes through the reminder flow', async () => {
    await mountWith({ granted: false, status: 'undetermined' });
    await waitFor(() => expect(screen.getByTestId('layover-return-alerts-enable')).toBeTruthy());
    expect(notifications.scheduleLocalNotificationAt).not.toHaveBeenCalled();
    layoverService.setReturnDeadline.mockClear();
    await act(async () => { fireEvent.press(screen.getByTestId('layover-return-alerts-enable')); });
    await waitFor(() => expect(layoverService.setReturnDeadline).toHaveBeenCalledWith('sess-1', 30));
  });

  it('ending the layover cancels the alerts it scheduled', async () => {
    await mountWith({ granted: true, status: 'granted' });
    await waitFor(() => expect(notifications.scheduleLocalNotificationAt).toHaveBeenCalledTimes(2));
    notifications.cancelScheduledNotification.mockClear();
    await waitFor(() => expect(screen.getByTestId('layover-end-open')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('layover-end-open')); });
    await waitFor(() => expect(screen.getByTestId('layover-end-completed')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
    await waitFor(() => expect(layoverService.endLayoverSession).toHaveBeenCalled());
    await waitFor(() => {
      const ids = notifications.cancelScheduledNotification.mock.calls.map((c: [string | null]) => c[0]);
      expect(ids).toEqual(expect.arrayContaining(['notif-1', 'notif-2']));
    });
  });

  for (const ended of ['completed', 'cancelled', 'expired']) {
    it(`an ENDED layover (${ended}) re-arms nothing and cancels the alerts an earlier mount left (verifier F1)`, async () => {
      notifications.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
      notifications.scheduleLocalNotificationAt.mockClear();
      notifications.cancelScheduledNotification.mockClear();
      await AsyncStorage.clear();
      await AsyncStorage.setItem(returnAlertsKey('sess-1'), JSON.stringify({
        version: 1, sessionId: 'sess-1', hardReturnTime: HARD_RETURN, ids: ['old-1', 'old-2'],
        alerts: [{ rung: 'RETURN_SOON', at: new Date(Date.parse(HARD_RETURN) - 30 * 60_000).toISOString() }, { rung: 'RETURN_NOW', at: HARD_RETURN }],
      }));
      (global as any).__bundle = bundle();
      const body = overviewBody(undefined);
      (global as any).__overview = { ...body, session: { ...body.session, status: ended } };
      await render(<LayoverDashboardScreen />);
      await waitFor(() => {
        const ids = notifications.cancelScheduledNotification.mock.calls.map((c: [string | null]) => c[0]);
        expect(ids).toEqual(expect.arrayContaining(['old-1', 'old-2']));
      });
      expect(notifications.scheduleLocalNotificationAt).not.toHaveBeenCalled();
      expect(await AsyncStorage.getItem(returnAlertsKey('sess-1'))).toBeNull();
      expect(screen.queryByTestId('layover-return-alerts-text')).toBeNull();
    });
  }
});
