/**
 * LayoverSafeReturnCard — §15.1 one-tap abort, end to end from the press.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * "The button exists" is not "the button calls the endpoint", so nothing here
 * mocks `services/layover`. The real service module runs; only `fetch` and the
 * two auth modules underneath it are replaced. The URL, the method and the
 * number of requests are asserted directly on the fetch spy — a handler wired
 * to the wrong route, or to nothing, fails.
 *
 * The response bodies are transcribed from the server that produces them
 * (artifacts/api-server/src/routes/airport.ts and
 *  services/airport/LayoverSafeReturnService.ts): the 200 is a whole
 * `AbortResult` + `statusCapability`, and the 500 is the real failure body,
 * which carries `ok:false` AND `returnContract` AND `posture`. A UI that
 * rendered a generic error on that path fails the partial-abort test.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverSafeReturnCard } from '../LayoverSafeReturnCard.tsx';
import type { LayoverOverview } from '../../../services/layover.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
// The card never touches Supabase directly; only the token helper below does.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

// ── Fixtures, transcribed from the server ─────────────────────────────────────

const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const CERTIFIED_MS = Date.parse(CERTIFIED_AT);
const HARD_RETURN = '2026-09-08T13:40:00.000Z';

const CERTIFICATION = {
  engineVersion: '2026.09.02-3',
  feasibilityVersion: '2026.09.05-1',
  inputHash: 'a1b2c3d4e5f60718',
  computedAt: CERTIFIED_AT,
  verdict: 'tight',
  confidence: 'LOW',
  bufferPercentile: 'p90',
} as const;

const POSTURE = {
  safeReturnVersion: '2026.09.08-1',
  returnState: 'RETURN_SOON',
  explorationCollapsed: false,
  returnRoutePrimary: false,
  pinTerminalContext: false,
  notifyCrew: true,
  offerRecoveryHelp: false,
  primaryAction: 'plan_return',
  abortAvailable: true,
  minutesToHardReturn: 42,
} as const;

const RETURN_CONTRACT = {
  safeReturnVersion: '2026.09.08-1',
  hardReturnTime: HARD_RETURN,
  returnState: 'RETURN_SOON',
  minutesToHardReturn: 42,
  bufferMinutes: 95,
  breakdown: {
    baseBuffer: 60, immigrationExtra: 20, bagsExtra: 15, trafficExtra: 0,
    timeOfDayExtra: 0, totalBuffer: 95, exitDelay: 40,
  },
  airport: {
    id: 'ap-1', iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok',
    country: 'Thailand', timezone: 'Asia/Bangkok', lat: 13.68, lng: 100.74,
    terminalInfo: null,
  },
  route: null,
  routeUnavailableReason: 'no_routing_provider',
  certification: CERTIFICATION,
} as const;

function overviewFixture(opts: { certifiedAt?: string; staleAfter?: string } = {}): LayoverOverview {
  const certifiedAt = opts.certifiedAt ?? CERTIFIED_AT;
  const staleAfter = opts.staleAfter ?? '2026-09-08T10:15:00.000Z';
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
      breakdown: {
        baseBuffer: 60, immigrationExtra: 20, bagsExtra: 15, trafficExtra: 0,
        timeOfDayExtra: 0, totalBuffer: 95, exitDelay: 40,
      },
      tier: 'half_day', tierLabel: 'Half day', tierBlurb: 'Plenty of time.',
      overnight: false, returnState: 'RETURN_SOON', engineVersion: '2026.09.02-3',
    },
    advice: {
      verdict: 'tight', reasons: ['Tight but doable'], unknowns: ['No measured route'],
      reasonCodes: ['NO_MEASURED_ROUTE'], disclaimer: 'Estimates only.',
      engineVersion: '2026.09.02-3',
    },
    stops: [],
    planFit: {
      totalPlannedMin: 0, returnTravelMin: 0, neededMin: 0, usableMinutes: 345,
      fitsWindow: true, overflowMin: 0, backByTime: HARD_RETURN,
    },
    share: { enabled: false, othersInCity: 0 },
    certification: { ...CERTIFICATION },
    safeReturn: { ...POSTURE },
    offlineBundle: {
      bundleVersion: '2026.09.08-1',
      sessionId: 'sess-1',
      certifiedAt,
      staleAfter,
      certification: { ...CERTIFICATION },
      returnDeadline: {
        hardReturnTime: HARD_RETURN, hardReturnLocal: '20:40',
        returnState: 'RETURN_SOON', bufferMinutes: 95, returnReminderAt: null,
      },
      airport: {
        iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
        timezone: 'Asia/Bangkok', lat: 13.68, lng: 100.74, terminalInfo: null,
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
      timezone: 'Asia/Bangkok', airportNow: '17:00', airportToday: '2026-09-08',
      arrivalLocal: '15:00', arrivalDay: '2026-09-08',
      departureLocal: '23:00', departureDay: '2026-09-08',
      boardingLocal: null, hardReturnLocal: '20:40',
    },
  } as LayoverOverview;
}

/** The real 200 body: AbortResult spread + statusCapability. */
const ABORT_OK_BODY = {
  ok: true,
  safeReturnVersion: '2026.09.08-1',
  abortedAt: '2026-09-08T10:05:00.000Z',
  returnContract: RETURN_CONTRACT,
  posture: { ...POSTURE, returnState: 'RETURN_NOW', primaryAction: 'return_now' },
  cancelledStopIds: ['stop-a', 'stop-b'],
  effects: ['itinerary_cancelled', 'status_unchanged_flag_off', 'ledger_recorded', 'crew_notify_unavailable'],
  crewNotified: [],
  crewNotifyUnavailableReason: 'no_crew_storage',
  statusApplied: false,
  statusCapability: 'flag_off',
};

/** The real 500 body: ok:false, and the contract still on board. */
const ABORT_PARTIAL_BODY = {
  ok: false,
  error: 'db_error',
  message: 'Your plan could not be fully cleared. Head to the airport now.',
  returnContract: RETURN_CONTRACT,
  posture: { ...POSTURE, returnState: 'RETURN_NOW', primaryAction: 'return_now' },
  effects: ['itinerary_cancelled', 'status_unchanged_flag_off', 'ledger_write_failed', 'crew_notify_unavailable'],
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as any).fetch = fetchSpy;
});

afterEach(() => {
  jest.clearAllMocks();
});

function returnNowCalls() {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/return-now'));
}

// ── The press reaches the endpoint ────────────────────────────────────────────

test('the RETURN TO AIRPORT press POSTs to /return-now for this session', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, ABORT_OK_BODY));
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  fireEvent.press(screen.getByTestId('return-to-airport-btn'));

  await waitFor(() => expect(returnNowCalls()).toHaveLength(1));
  const [url, init] = returnNowCalls()[0];
  expect(String(url)).toContain('/api/airport/sessions/sess-1/return-now');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer test-token');
});

test('a double tap fires exactly one request', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, ABORT_OK_BODY));
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  // Two presses in the SAME frame — invoked straight off the element so both
  // land before React can commit `busy`, which is the situation a state-only
  // guard loses. The guard is a ref written synchronously by the first press,
  // so the second returns before it reaches fetch.
  //
  // (Both presses go inside ONE outer act. RNTL wraps each press in its own
  // act(), and two of those as siblings corrupt actScopeDepth for the rest of
  // the file under React 19 — see src/jest.setup.ts.)
  const btn = screen.getByTestId('return-to-airport-btn');
  await act(async () => {
    fireEvent.press(btn);
    fireEvent.press(btn);
  });

  await waitFor(() => expect(screen.getByTestId('return-contract')).toBeTruthy());
  expect(returnNowCalls()).toHaveLength(1);
});

// ── Success renders the contract ──────────────────────────────────────────────

test('a successful abort renders the hard return time, the time left and what was cancelled', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, ABORT_OK_BODY));
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  fireEvent.press(screen.getByTestId('return-to-airport-btn'));

  await waitFor(() => expect(screen.getByTestId('return-contract')).toBeTruthy());
  expect(screen.getByTestId('contract-hard-time').props.children.join('')).toMatch(/42m left/);
  expect(screen.getByTestId('contract-cancelled-count')).toBeTruthy();
  // No routing provider exists — the absence is stated, not silently omitted.
  expect(screen.getByTestId('contract-route-unavailable')).toBeTruthy();
});

// ── THE failure path ──────────────────────────────────────────────────────────

test('a 500 partial abort still shows the return contract, not a generic error', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(500, ABORT_PARTIAL_BODY));
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  fireEvent.press(screen.getByTestId('return-to-airport-btn'));

  await waitFor(() => expect(screen.getByTestId('abort-partial-notice')).toBeTruthy());
  // The contract survived the failure — this is the whole point of the path.
  expect(screen.getByTestId('return-contract')).toBeTruthy();
  expect(screen.getByTestId('contract-hard-time')).toBeTruthy();
  expect(screen.getByText(/Head to the airport now/)).toBeTruthy();
  expect(screen.getByText(/Head to BKK now/)).toBeTruthy();
  // The failed effect is reported, not swallowed.
  expect(screen.getByText(/not recorded in your layover history/)).toBeTruthy();
});

test('an already-ended session (400) is reported as ended, not as a retryable error', async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(400, { error: 'invalid_payload', message: 'This layover is already completed.' }),
  );
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  fireEvent.press(screen.getByTestId('return-to-airport-btn'));

  await waitFor(() => expect(screen.getByTestId('abort-already-ended')).toBeTruthy());
  expect(screen.getByText('This layover is already completed.')).toBeTruthy();
  expect(screen.queryByTestId('return-contract')).toBeNull();
});

test('offline keeps the last certified deadline on screen instead of blanking it', async () => {
  fetchSpy.mockRejectedValue(new TypeError('Network request failed'));
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);

  fireEvent.press(screen.getByTestId('return-to-airport-btn'));

  await waitFor(() => expect(screen.getByTestId('abort-offline')).toBeTruthy());
  expect(screen.getByTestId('safe-return-hard-time')).toBeTruthy();
});

// ── §16 staleness is a label, and it actually fires ──────────────────────────

test('a fresh bundle shows the deadline as live, with no staleness caption', async () => {
  await render(
    <LayoverSafeReturnCard
      overview={overviewFixture()}
      nowMs={CERTIFIED_MS + 5 * 60_000}
      canAbort
    />,
  );
  expect(screen.queryByTestId('safe-return-stale-notice')).toBeNull();
  expect(screen.getByText('Be back by')).toBeTruthy();
});

test('past staleAfter the deadline is relabelled and captioned with its age', async () => {
  await render(
    <LayoverSafeReturnCard
      overview={overviewFixture()}
      nowMs={CERTIFIED_MS + 40 * 60_000}
      canAbort
    />,
  );
  expect(screen.getByTestId('safe-return-stale-notice')).toBeTruthy();
  expect(screen.getByText(/Last certified 40 min ago/)).toBeTruthy();
  expect(screen.getByText('Last certified return time')).toBeTruthy();
  // Stale never means hidden: the deadline itself is still on screen.
  expect(screen.getByTestId('safe-return-hard-time')).toBeTruthy();
});

// ── §2.1 certification is on screen ──────────────────────────────────────────

test('the certification line names when the answer was computed and by which rules', async () => {
  await render(<LayoverSafeReturnCard overview={overviewFixture()} nowMs={CERTIFIED_MS} canAbort />);
  const line = screen.getByTestId('safe-return-certification');
  const text = (line.props.children as unknown[]).join('');
  expect(text).toContain('engine 2026.09.02-3');
  expect(text).toContain('feasibility 2026.09.05-1');
  expect(text).toContain('confidence low');
  expect(text).toContain('inputs a1b2c3d4');
});

// ── §15 posture drives the headline ──────────────────────────────────────────

test('the certified return state, not the local clock, drives the headline', async () => {
  const ov = overviewFixture();
  const escalated: LayoverOverview = {
    ...ov,
    safeReturn: { ...ov.safeReturn, returnState: 'CONNECTION_AT_RISK', primaryAction: 'recover_connection' },
  };
  await render(<LayoverSafeReturnCard overview={escalated} nowMs={CERTIFIED_MS} canAbort />);
  expect(screen.getByTestId('safe-return-title').props.children).toBe('Your connection is at risk');
  expect(screen.getByTestId('safe-return-state').props.children).toBe('CONNECTION AT RISK');
});

test('a non-active session offers no abort control at all', async () => {
  const ov = overviewFixture();
  const ended: LayoverOverview = { ...ov, session: { ...ov.session, status: 'completed' } };
  await render(<LayoverSafeReturnCard overview={ended} nowMs={CERTIFIED_MS} canAbort={false} />);
  expect(screen.queryByTestId('return-to-airport-btn')).toBeNull();
  expect(screen.getByTestId('safe-return-inactive')).toBeTruthy();
});
