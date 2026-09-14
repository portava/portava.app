/**
 * census L265 — "**Notification storm** — material-change threshold +
 *                suppression/debounce"
 * census L99  — "Notify only when user action should change"
 *
 * The server half is
 * `artifacts/api-server/src/services/airport/__tests__/layoverReminderDrift.test.ts`.
 * This is the half that a traveller can see, and the one the defect lived in:
 *
 *   The footer said "Reminder set", in green, for a notification scheduled
 *   against a deadline the flight had since moved away from. `15m earlier` on
 *   the flight-change card moves the certified hard return fifteen minutes in,
 *   and the reminder stays where it was — fifteen minutes INSIDE the window it
 *   was meant to open — while the screen goes on asserting a warning is in
 *   place.
 *
 * Three cases, and the middle one is the requirement people forget:
 *   - drift below the threshold  → NOTHING renders. Suppression is half of
 *     L265, and a banner on a two-minute jitter is the storm in another form.
 *   - drift above it             → the banner names the movement and offers the
 *     corrected time; the footer stops claiming the reminder is set.
 *   - too late to warn anyone    → the banner says so and offers no tap, rather
 *     than proposing an instant in the past.
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Applied to the screen, measured, reverted, `cmp`-verified.
 *  1. render the banner for every disposition (drop the `reminderStale` test)
 *                                                            → 1 failed.
 *  2. keep the footer reading "Reminder set" when stale       → 1 failed.
 *  3. treat `cancel` as tappable                              → 1 failed.
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

// NOTE: intentional stub — expo-notifications needs a native runtime. The
// SCHEDULING path is not what this file is about: the defect was the screen
// asserting a warning was in place, which is a render, not a schedule.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt: jest.fn(async () => null),
  cancelScheduledNotification: jest.fn(async () => undefined),
  notificationPromptWouldAppear: jest.fn(async () => false),
}));

// NOTE: intentional stubs — each pulls maps, discovery or presence chains that
// have nothing to do with the reminder banner.
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
// NOTE: intentional stub — see above.
jest.mock('../../../src/components/layover/LayoverCompassCard', () => ({ LayoverCompassCard: () => null }));

// NOTE: intentional stub — the screen only needs data to render here; the real
// service is exercised against a fetch spy in the card suites.
jest.mock('../../../src/services/layover', () => ({
  getLayoverOverview: jest.fn(async () => (global as any).__overview),
  getRecommendations: jest.fn(async () => []),
  getLayoverBuddies: jest.fn(async () => ({ city: 'Taipei', buddies: [] })),
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
    safeEnvelope: null, offlineBundle: null,
    returnReminderAt: new Date(NOW + 2 * HOUR).toISOString(),
    ...(reminder === undefined ? {} : { reminder }),
    localTimes: {
      timezone: 'Asia/Taipei', airportNow: '20:00', airportToday: '2026-09-14',
      arrivalLocal: '19:00', arrivalDay: '2026-09-14',
      departureLocal: '02:00', departureDay: '2026-09-15',
    },
  };
}

const KEEP = { action: 'keep', reason: 'below_material_threshold', driftMinutes: 2, materialChange: false, firesAt: null, staleFiresAt: new Date(NOW + 2 * HOUR).toISOString() };
const MOVED = { action: 'reschedule', reason: 'deadline_moved', driftMinutes: -15, materialChange: true, firesAt: new Date(NOW + 105 * 60_000).toISOString(), staleFiresAt: new Date(NOW + 2 * HOUR).toISOString() };
const GONE = { action: 'cancel', reason: 'rung_already_passed', driftMinutes: -200, materialChange: true, firesAt: null, staleFiresAt: new Date(NOW + 2 * HOUR).toISOString() };

async function mount(reminder: Record<string, unknown> | undefined) {
  (global as any).__overview = overviewBody(reminder);
  await render(<LayoverDashboardScreen />);
  await waitFor(() => expect(screen.getByTestId('layover-remind-me')).toBeTruthy());
}

describe('L265 — the material-change threshold, on the screen', () => {
  it('a drift below the threshold renders NOTHING — suppression is the requirement', async () => {
    await mount(KEEP);
    expect(screen.queryByTestId('reminder-drift')).toBeNull();
    expect(screen.getByText('Reminder set')).toBeTruthy();
  });

  it('a material move names the movement and offers the corrected time', async () => {
    await mount(MOVED);
    const body = screen.getByTestId('reminder-drift-body');
    const text = String((body.props as { children: unknown }).children);
    expect(text).toContain('15 min');
    expect(screen.queryByText('Reminder set')).toBeNull();
    expect(screen.getByText('Reminder out of date')).toBeTruthy();
  });

  it('a reminder too late to warn anyone says so and is not tappable', async () => {
    await mount(GONE);
    const card = screen.getByTestId('reminder-drift');
    expect((card.props as { accessibilityState?: { disabled?: boolean } }).accessibilityState?.disabled).toBe(true);
    const title = screen.getByTestId('reminder-drift-title');
    expect(String((title.props as { children: unknown }).children)).toContain('no longer');
  });

  it('a server that publishes no disposition renders exactly what it always did', async () => {
    await mount(undefined);
    expect(screen.queryByTestId('reminder-drift')).toBeNull();
    expect(screen.getByText('Reminder set')).toBeTruthy();
  });
});
