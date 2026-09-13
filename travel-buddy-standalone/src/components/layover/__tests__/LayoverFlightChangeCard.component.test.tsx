/**
 * LayoverFlightChangeCard — the traveller as a §11 event producer.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * "The card exists" is not "the card is the ingest", so nothing here mocks
 * `services/layover`. The real service module runs; only `fetch` and the two
 * auth modules underneath it are replaced. The URL, the method and the PATCH
 * BODY are asserted on the fetch spy: a card that shifts departure without
 * shifting boarding, or that PATCHes the wrong session, fails — and shifting
 * them apart is exactly what the server refuses with
 * `boarding_moved_independently`, so the assertion is about a real refusal and
 * not about a house style.
 *
 * The response bodies are transcribed from the server that produces them
 * (artifacts/api-server/src/services/airport/LayoverReplanService.ts,
 *  `ReplanPublication`), including the members this tree cannot fill:
 * `snapshotPersisted: false` and `snapshotUnavailableReason`.
 *
 * A REFUSAL IS NOT AN ERROR. Most edits are `window_unchanged`, and a card that
 * rendered nothing on a refusal would leave a traveller who pressed a button
 * looking at a screen that did not answer. That case has its own test.
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Applied to the card, measured, reverted, `cmp`-verified. Unmutated: 10 pass.
 *
 *  1. `LayoverFlightChangeCard.apply` — send `departureTime` alone and drop the
 *     matching boarding shift.                              → 1 failed.
 *     Boarding then drifts away from departure and the SERVER refuses the
 *     replan with `boarding_moved_independently`, so the visible symptom is a
 *     control that silently stops replanning for anyone with a boarding time.
 *  2. `LayoverFlightChangeCard` — render the alert regardless of
 *     `notify.notify`.                                      → 1 failed.
 *     §11.1 step 8 stops gating anything and every material change shouts.
 *  3. `app/layover/[id].tsx` — remove `<LayoverFlightChangeCard>` from the
 *     screen.                                               → 1 failed, in
 *     `app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx`,
 *     and NOTHING ELSE in the repository went red. That is the whole
 *     reachability claim of this pass hanging on one assertion, which is why
 *     that assertion exists.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverFlightChangeCard, replanLines } from '../LayoverFlightChangeCard.tsx';
import type { LayoverSession, ReplanOutcome } from '../../../services/layover.ts';

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

const DEPARTURE = '2026-09-13T16:00:00.000Z';
const BOARDING = '2026-09-13T15:30:00.000Z';

function sessionFixture(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: 'sess-1', userId: 'u-1', airportId: 'ap-1', tripId: null,
    arrivalTime: '2026-09-13T08:00:00.000Z', departureTime: DEPARTURE,
    boardingTime: null, layoverMinutes: 480, flightType: 'international',
    immigrationRequired: true, checkedBags: false, loungeAccess: false,
    wantsToLeave: true, comfortLevel: 'moderate', vibeChips: [],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
    status: 'active', createdAt: '2026-09-13T07:00:00.000Z',
    ...over,
  } as LayoverSession;
}

const CERTIFICATION = {
  engineVersion: '2026.09.13-1',
  feasibilityVersion: '2026.09.13-1',
  inputHash: 'a1b2c3d4e5f60718',
  computedAt: '2026-09-13T09:00:00.000Z',
  verdict: 'yes',
  confidence: 'LOW',
  bufferPercentile: 'p90',
};

/** The real `ReplanPublication`, spread under `ran: true` by the route. */
function publication(over: Record<string, unknown> = {}): ReplanOutcome {
  return {
    ran: true,
    wiringVersion: '2026.09.13-1',
    replannerVersion: '2026.09.13-1',
    event: {
      eventId: 'e-1', eventType: 'flight.departure_delayed',
      occurredAt: '2026-09-13T09:00:00.000Z', receivedAt: '2026-09-13T09:00:00.000Z',
      source: 'portava.layover.session_edit', dedupKey: 'sha256:abc', confidence: 'HIGH',
    },
    diff: {
      verdictChanged: false, returnStateChanged: false, tierChanged: false,
      usableMinutesDelta: 60, deadlineDeltaMinutes: 60,
      candidatesGained: [], candidatesLost: [],
      reasonCodesAdded: [], reasonCodesRemoved: [],
    },
    invalidation: { noLongerFeasible: [], staleCertification: [], newInputHash: 'a1b2c3d4e5f60718' },
    opportunity: { why: ['usable time moved by 60 min'], reasonCodes: ['FLIGHT_DELAY_CREATED_OPPORTUNITY'] },
    notify: { notify: true, priority: 'normal', reason: 'a delay opened a materially larger window' },
    disruptionState: 'DELAYED',
    certification: CERTIFICATION as any,
    reasonCodes: ['FLIGHT_DELAY_CREATED_OPPORTUNITY'],
    snapshotPersisted: false,
    snapshotUnavailableReason: 'no_snapshot_storage',
    counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 1 },
    ...over,
  } as ReplanOutcome;
}

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

function patchCalls() {
  return fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PATCH');
}

// ── The press reaches the ingest ──────────────────────────────────────────────

test('a delay press PATCHes this session with the shifted departure', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, session: sessionFixture(), replan: publication() }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-60'));

  await waitFor(() => expect(patchCalls()).toHaveLength(1));
  const [url, init] = patchCalls()[0];
  expect(String(url)).toContain('/api/airport/sessions/sess-1');
  expect(init.headers.Authorization).toBe('Bearer test-token');
  expect(JSON.parse(init.body)).toEqual({ departureTime: '2026-09-13T17:00:00.000Z' });
});

test('boarding moves with departure, by the same minutes, or the server refuses the replan', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, session: sessionFixture(), replan: publication() }));
  await render(
    <LayoverFlightChangeCard
      session={sessionFixture({ boardingTime: BOARDING })}
      canEdit
      onChanged={() => {}}
      onError={() => {}}
    />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-30'));

  await waitFor(() => expect(patchCalls()).toHaveLength(1));
  expect(JSON.parse(patchCalls()[0][1].body)).toEqual({
    departureTime: '2026-09-13T16:30:00.000Z',
    boardingTime: '2026-09-13T16:00:00.000Z',
  });
});

test('the dashboard is told to re-certify after the edit', async () => {
  const onChanged = jest.fn();
  fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, session: sessionFixture(), replan: publication() }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={onChanged} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-15'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

// ── What the traveller is told ────────────────────────────────────────────────

test("the server's own diff is what is rendered, not a client re-derivation", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, session: sessionFixture(), replan: publication() }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-60'));
  await waitFor(() => screen.getByTestId('replan-outcome'));
  expect(screen.getByText('You have 60 more minutes before you must head back.')).toBeTruthy();
  expect(screen.getByText('Usable time went up by 60 min.')).toBeTruthy();
  expect(screen.getByTestId('replan-notify')).toBeTruthy();
});

test('step 8 gates the alert: a material change with no notification says so', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, {
    ok: true,
    session: sessionFixture(),
    replan: publication({
      notify: { notify: false, reason: 'options moved, but nothing the traveller should do differently' },
      counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 0 },
    }),
  }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-15'));
  await waitFor(() => screen.getByTestId('replan-no-notify'));
  expect(screen.queryByTestId('replan-notify')).toBeNull();
});

test('a lost planned stop is named and RECOMMENDATION_EXPIRED is surfaced', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, {
    ok: true,
    session: sessionFixture(),
    replan: publication({
      diff: {
        verdictChanged: false, returnStateChanged: false, tierChanged: false,
        usableMinutesDelta: -60, deadlineDeltaMinutes: -60,
        candidatesGained: [], candidatesLost: ['stop-1'],
        reasonCodesAdded: [], reasonCodesRemoved: [],
      },
      invalidation: { noLongerFeasible: ['stop-1'], staleCertification: [], newInputHash: 'ff00' },
      notify: { notify: true, priority: 'high', reason: 'a planned option no longer fits the window' },
      reasonCodes: ['FLIGHT_MOVED_EARLIER', 'RECOMMENDATION_EXPIRED'],
    }),
  }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift--15'));
  await waitFor(() => screen.getByTestId('replan-recommendation-expired'));
  expect(screen.getByText('1 planned stop(s) no longer fit your window.')).toBeTruthy();
  expect(screen.getByText('You must head back 60 minutes earlier.')).toBeTruthy();
});

test('a refusal is shown in words instead of leaving the press unanswered', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, {
    ok: true,
    session: sessionFixture(),
    replan: { ran: false, reason: 'window_unchanged', detail: 'no feasibility input moved' },
  }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-15'));
  await waitFor(() => screen.getByTestId('replan-refusal'));
  expect(screen.getByText('That would leave your times exactly as they are.')).toBeTruthy();
  expect(screen.queryByTestId('replan-outcome')).toBeNull();
});

test('an older server that publishes no replan is reported as such, not as "nothing changed"', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true, session: sessionFixture() }));
  await render(
    <LayoverFlightChangeCard session={sessionFixture()} canEdit onChanged={() => {}} onError={() => {}} />,
  );

  fireEvent.press(screen.getByTestId('flight-shift-15'));
  await waitFor(() => screen.getByTestId('replan-refusal'));
  expect(screen.getByText('This server does not report replans yet.')).toBeTruthy();
});

test('a closed layover offers no flight-change control at all', async () => {
  await render(
    <LayoverFlightChangeCard
      session={sessionFixture({ status: 'cancelled' })}
      canEdit={false}
      onChanged={() => {}}
      onError={() => {}}
    />,
  );
  expect(screen.queryByTestId('layover-flight-change-card')).toBeNull();
});

// ── The sentence generator, on its own ────────────────────────────────────────

test('replanLines never returns an empty list — a press always gets an answer', () => {
  const flat = publication({
    diff: {
      verdictChanged: false, returnStateChanged: false, tierChanged: false,
      usableMinutesDelta: 0, deadlineDeltaMinutes: 0,
      candidatesGained: [], candidatesLost: [],
      reasonCodesAdded: [], reasonCodesRemoved: [],
    },
  }) as Extract<ReplanOutcome, { ran: true }>;
  expect(replanLines(flat)).toEqual(['Nothing you can act on moved.']);
});
