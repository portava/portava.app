/**
 * LayoverDisruptionCard — census-layover L148, L149, L231: a traveller reports
 * a disruption from the layover screen, and sees what the SERVER did with it.
 *
 *   L148  §15.2 "CONNECTION → DELAYED → SEVERE_DELAY → OVERNIGHT
 *                ↘ CANCELLED → REBOOKING / RECOVERY"
 *   L149  §15.2 "Disruption may expand or shrink the FreedomWindow. Recompute;
 *                do not simply append delay minutes."
 *   L231  §21.1 "Flight cancellation → Transition to disruption/recovery"
 *
 * ── WHAT IS DRIVEN ───────────────────────────────────────────────────────────
 * The REAL card over the REAL service (`services/layoverDisruption.ts`): only
 * `fetch` and the token helper are replaced. So every case pins the wire as
 * well as the screen — the URL, the method and the body the route's
 * `disruptionSchema` reads — and the server's answer is a body shaped exactly
 * as `routes/airport.ts` writes it.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * A card that labelled a state from its own reading of the delay (case 2), that
 * printed a window delta it subtracted (case 5), that offered rebooking help
 * the server says does not exist (case 6), that sent a cancellation on one
 * tap (case 7), or that forgot the server's recorded answer on a reload
 * (case 9).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LayoverDisruptionCard } from '../LayoverDisruptionCard.tsx';
import { readRememberedDisruption } from '../../../services/layoverDisruption.ts';

// NOTE: intentional stub — the real helper reads a Supabase session through the
// native SecureStore adapter; this suite is about the disruption wire, and a
// fixed token lets it assert the Authorization header the route requires.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

const NOW = Date.now();
const HOUR = 3_600_000;

type Answer = { status: number; body: unknown };
let answers: Answer[] = [];
let calls: Array<{ url: string; init: any }> = [];
let fetchRejects = false;

function respond(a: Answer) {
  return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  answers = [];
  calls = [];
  fetchRejects = false;
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    if (fetchRejects) throw new TypeError('Network request failed');
    const next = answers.shift();
    if (!next) throw new Error('test: no server answer queued');
    return respond(next);
  });
});

const POSTURE = {
  recoveryNeeded: false,
  rebooking: { available: false, reason: 'no_airline_integration' },
  airlineContact: { available: false, reason: 'no_airline_directory' },
  airportHelp: { available: false, reason: 'no_airport_help_directory' },
};

/** The body `POST /:id/disruption` writes, with the parts a case varies. */
function serverBody(over: {
  state: string; previousState?: string; previousStateSource?: string;
  event?: Record<string, unknown>; recompute?: unknown; recoveryNeeded?: boolean; stateRecorded?: boolean;
  ok?: boolean; recovery?: unknown;
}) {
  return {
    ...(over.ok === false ? { ok: false, error: 'db_error', message: 'We applied this change but could not record it. Check your flight status again in a moment.' } : { ok: true }),
    disruption: {
      source: 'traveller',
      previousState: over.previousState ?? 'CONNECTION',
      previousStateSource: over.previousStateSource ?? 'default',
      state: over.state,
      event: over.event ?? { kind: 'cancellation' },
      baselineDepartureTime: new Date(NOW + 6 * HOUR).toISOString(),
      stateRecorded: over.stateRecorded ?? true,
    },
    recompute: over.recompute ?? null,
    recovery: over.recovery !== undefined ? over.recovery : { ...POSTURE, recoveryNeeded: over.recoveryNeeded ?? false },
    safeReturn: null,
    certification: { engineVersion: 'v', feasibilityVersion: 'v', inputHash: 'h', computedAt: new Date(NOW).toISOString(), verdict: 'tight', confidence: 'LOW', bufferPercentile: 'p90' },
  };
}

async function mount(over: Partial<React.ComponentProps<typeof LayoverDisruptionCard>> = {}) {
  const onReported = jest.fn();
  const view = await render(
    <LayoverDisruptionCard
      sessionId="sess-1"
      canReport
      timezone="Asia/Bangkok"
      departureLocal="2026-09-08 23:00"
      onReported={onReported}
      {...over}
    />,
  );
  return { onReported, view };
}

function sentBody(i = 0): Record<string, unknown> {
  return JSON.parse(String(calls[i].init.body));
}

describe('L148 — the traveller reports, the server decides the state', () => {
  it('1. a delay sent as the new LOCAL departure reaches the route and the server state is shown', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'DELAYED', event: { kind: 'delay', delayMinutes: 30 } }) });
    const { onReported } = await mount();

    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    // Pre-filled with the server's own local departure, so the traveller edits a time rather than types one.
    expect(screen.getByTestId('layover-disruption-new-departure').props.value).toBe('2026-09-08 23:00');
    await fireEvent.changeText(screen.getByTestId('layover-disruption-new-departure'), '2026-09-08 23:30');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));

    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-DELAYED')).toBeTruthy());
    // The wire: the route, POST, the token, and the local wall time as the schema names it.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/airport\/sessions\/sess-1\/disruption$/);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
    expect(sentBody()).toEqual({ kind: 'delay', newDepartureLocal: '2026-09-08 23:30' });
    // The server's previous state and where it came from.
    expect(String(screen.getByTestId('layover-disruption-previous').props.children.join(''))).toMatch(/On schedule — nothing had been reported/);
    // The source is said: there is no flight feed.
    expect(screen.getByText(/Source: your report\. Portava has no flight feed\./)).toBeTruthy();
    expect(screen.getByText(/Total delay counted from your original departure: 30m/)).toBeTruthy();
    expect(onReported).toHaveBeenCalledTimes(1);
  });

  it('2. the card shows the SERVER\'s state even where no client rule would produce it', async () => {
    // A 30-minute total with SEVERE_DELAY back: a client that labelled the state
    // from the minutes it sent would print "Delayed" here.
    answers.push({ status: 200, body: serverBody({ state: 'SEVERE_DELAY', previousState: 'DELAYED', previousStateSource: 'ledger', event: { kind: 'delay', delayMinutes: 30 } }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.changeText(screen.getByTestId('layover-disruption-delay-minutes'), '30');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-delay-minutes'));

    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-SEVERE_DELAY')).toBeTruthy());
    expect(sentBody()).toEqual({ kind: 'delay', delayMinutes: 30 });
    expect(screen.queryByTestId('layover-disruption-state-DELAYED')).toBeNull();
    // The WORDS a traveller reads are the server's state too, not only the testID.
    expect(screen.getByTestId('layover-disruption-state-SEVERE_DELAY').props.children).toBe('Severely delayed');
    // The previous state is the ledger's, and the card says nothing about "nothing reported".
    expect(String(screen.getByTestId('layover-disruption-previous').props.children.join(''))).toBe('Before this report: Delayed');
  });

  it('3. a state this build has no label for is shown as its own code, not mapped onto a neighbour', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'HOLDING_PATTERN', event: { kind: 'on_time' } }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-on_time'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-HOLDING_PATTERN')).toBeTruthy());
    expect(screen.getByText('HOLDING_PATTERN')).toBeTruthy();
    expect(sentBody()).toEqual({ kind: 'on_time' });
  });

  it('4. a total-minutes report moves no schedule, and the card says the window was NOT recomputed', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'DELAYED', event: { kind: 'delay', delayMinutes: 90 } }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.changeText(screen.getByTestId('layover-disruption-delay-minutes'), '90');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-delay-minutes'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-DELAYED')).toBeTruthy());
    expect(screen.queryByTestId('layover-disruption-recompute')).toBeNull();
    expect(screen.getByTestId('layover-disruption-no-recompute')).toBeTruthy();
  });
});

describe('L149 — the window is the server\'s recompute, before and after', () => {
  const recompute = (over: Record<string, unknown> = {}) => ({
    scheduleDeltaMinutes: 120,
    usableMinutesDelta: 70,
    recomputedNotAppended: true,
    returnStateChanged: false,
    before: { usableMinutes: 190, returnState: 'NORMAL', hardReturnTime: new Date(NOW + 3 * HOUR).toISOString() },
    after: { usableMinutes: 260, returnState: 'NORMAL', hardReturnTime: new Date(NOW + 4 * HOUR).toISOString(), hardReturnLocal: '20:40' },
    ...over,
  });

  it('5. it EXPANDED by less than the delay: both sides, the server\'s delta, and recomputedNotAppended', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'DELAYED', event: { kind: 'delay', delayMinutes: 120 }, recompute: recompute() }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.changeText(screen.getByTestId('layover-disruption-new-departure'), '2026-09-09 01:00');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));

    await waitFor(() => expect(screen.getByTestId('layover-disruption-recompute')).toBeTruthy());
    expect(screen.getByText(/Usable time: 3h 10m → 4h 20m \(\+70 min\)/)).toBeTruthy();
    // The airport-local hard return is the server's string, verbatim.
    expect(screen.getByText(/→ 20:40/)).toBeTruthy();
    expect(screen.getByText(/Return state: NORMAL → NORMAL/)).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-recomputed-not-appended')).toBeTruthy();
    expect(screen.getByText(/Your flight moved \+120 min; your usable time moved \+70 min\. It was recomputed, not added on\./)).toBeTruthy();
  });

  it('6. it SHRANK although the flight moved later, and the card prints the server\'s number, not a subtraction', async () => {
    // usableMinutesDelta is deliberately NOT after − before (300 − 345 = −45):
    // the card prints what the server sent and subtracts nothing itself.
    answers.push({
      status: 200,
      body: serverBody({
        state: 'DELAYED', event: { kind: 'delay', delayMinutes: 120 },
        recompute: recompute({
          usableMinutesDelta: -44, returnStateChanged: true,
          before: { usableMinutes: 345, returnState: 'NORMAL', hardReturnTime: new Date(NOW + 3 * HOUR).toISOString() },
          after: { usableMinutes: 300, returnState: 'RETURN_SOON', hardReturnTime: new Date(NOW + 2 * HOUR).toISOString(), hardReturnLocal: '18:05' },
        }),
      }),
    });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.changeText(screen.getByTestId('layover-disruption-new-departure'), '2026-09-09 01:00');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));

    await waitFor(() => expect(screen.getByTestId('layover-disruption-recompute')).toBeTruthy());
    expect(screen.getByText(/Usable time: 5h 45m → 5h \(−44 min\)/)).toBeTruthy();
    expect(screen.getByText(/Return state: NORMAL → RETURN_SOON/)).toBeTruthy();
    expect(screen.getByText(/→ 18:05/)).toBeTruthy();
  });

  it('6b. when the recompute moved the window by exactly the flight\'s minutes, it says so rather than claiming a non-linear result', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'DELAYED', event: { kind: 'delay', delayMinutes: 120 }, recompute: recompute({ usableMinutesDelta: 120, recomputedNotAppended: false }) }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-recomputed-same')).toBeTruthy());
    expect(screen.queryByTestId('layover-disruption-recomputed-not-appended')).toBeNull();
  });
});

describe('L231 — a cancellation moves to CANCELLED, states the recovery posture, and offers REBOOKING / RECOVERY next', () => {
  it('7. one tap on "Cancelled" sends NOTHING: it asks first, because the server keeps a cancellation', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    expect(screen.getByTestId('layover-disruption-confirm')).toBeTruthy();
    expect(calls).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-back'));
    expect(screen.queryByTestId('layover-disruption-confirm')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('8. CANCELLED with recoveryNeeded: every kind of help reads unavailable with its reason, and the rebooking reports are offered', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'CANCELLED', recoveryNeeded: true }) });
    const { onReported } = await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));

    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
    expect(sentBody()).toEqual({ kind: 'cancellation' });
    expect(onReported).toHaveBeenCalledTimes(1);

    // The posture, said as it is. Nothing is offered that does not exist (census L145 is N).
    expect(screen.getByTestId('layover-disruption-recovery')).toBeTruthy();
    expect(screen.getByText('Rebooking: unavailable — Portava has no connection to any airline, so it cannot rebook you.')).toBeTruthy();
    expect(screen.getByText('Airline contact: unavailable — Portava has no airline contact directory.')).toBeTruthy();
    expect(screen.getByText('Airport help desk: unavailable — Portava has no directory of airport help desks.')).toBeTruthy();
    expect(screen.queryByText(/listed as available/)).toBeNull();

    // REBOOKING / RECOVERY next; the delay chain is not offered to a cancelled flight.
    expect(screen.getByTestId('layover-disruption-next')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-report-rebooking_offered')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-report-rebooking_confirmed')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-open-delay')).toBeNull();
  });

  it('8b. the walk continues on the server\'s answers: REBOOKING, then RECOVERY, each with its ledger previous state', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'CANCELLED', recoveryNeeded: true }) });
    answers.push({ status: 200, body: serverBody({ state: 'REBOOKING', previousState: 'CANCELLED', previousStateSource: 'ledger', event: { kind: 'rebooking_offered' }, recoveryNeeded: true }) });
    answers.push({ status: 200, body: serverBody({ state: 'RECOVERY', previousState: 'REBOOKING', previousStateSource: 'ledger', event: { kind: 'rebooking_confirmed' }, recoveryNeeded: false }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('layover-disruption-report-rebooking_offered'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-REBOOKING')).toBeTruthy());
    expect(sentBody(1)).toEqual({ kind: 'rebooking_offered' });
    expect(String(screen.getByTestId('layover-disruption-previous').props.children.join(''))).toBe('Before this report: Cancelled');

    await fireEvent.press(screen.getByTestId('layover-disruption-report-rebooking_confirmed'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-RECOVERY')).toBeTruthy());
    expect(sentBody(2)).toEqual({ kind: 'rebooking_confirmed' });
    expect(screen.getByTestId('layover-disruption-nothing-next')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-recovery')).toBeNull();
  });

  it('8c. a server that states no posture gets none invented', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'CANCELLED', recovery: null }) });
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
    expect(screen.queryByTestId('layover-disruption-recovery')).toBeNull();
    expect(screen.getByTestId('layover-disruption-recovery-unstated')).toBeTruthy();
  });
});

describe('L148 — a reload shows the remembered state', () => {
  it('9. the server\'s RECORDED answer survives a remount, captioned as this phone\'s copy', async () => {
    answers.push({ status: 200, body: serverBody({ state: 'CANCELLED', recoveryNeeded: true }) });
    const first = await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
    await waitFor(async () => expect(await readRememberedDisruption('sess-1')).not.toBeNull());
    await first.view.unmount();

    await mount();
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
    expect(screen.getByTestId('layover-disruption-remembered')).toBeTruthy();
    // Still the cancellation chain's next reports, from the remembered state.
    expect(screen.getByTestId('layover-disruption-report-rebooking_offered')).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it('10. an answer the server APPLIED but did not RECORD is shown with a warning and is not remembered', async () => {
    answers.push({ status: 500, body: serverBody({ ok: false, state: 'CANCELLED', stateRecorded: false, recoveryNeeded: true }) });
    const { onReported } = await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy());
    expect(screen.getByTestId('layover-disruption-not-recorded')).toBeTruthy();
    expect(screen.getByText(/could not record it/)).toBeTruthy();
    // The transition happened server-side, so the screen still re-reads.
    expect(onReported).toHaveBeenCalledTimes(1);
    expect(await readRememberedDisruption('sess-1')).toBeNull();
  });
});

describe('failures are said, never turned into a state', () => {
  it('11. no signal: the report is refused locally with the reason and nothing is shown as a state', async () => {
    fetchRejects = true;
    const { onReported } = await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-on_time'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-error')).toBeTruthy());
    expect(screen.getByText(/Could not reach Portava\. Nothing was reported/)).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-status')).toBeNull();
    expect(onReported).not.toHaveBeenCalled();
  });

  it('12. an unreadable ledger (503) shows the server\'s own sentence', async () => {
    answers.push({ status: 503, body: { error: 'degraded_unavailable', message: "We could not read this layover's disruption history, so we will not guess at it. Please try again.", retryable: true } });
    const { onReported } = await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-on_time'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-error')).toBeTruthy());
    expect(screen.getByText(/we will not guess at it/)).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-status')).toBeNull();
    expect(onReported).not.toHaveBeenCalled();
  });

  it('13. a malformed local time is refused before anything is sent', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('layover-disruption-open-delay'));
    await fireEvent.changeText(screen.getByTestId('layover-disruption-new-departure'), '7.30pm');
    await fireEvent.press(screen.getByTestId('layover-disruption-send-new-departure'));
    expect(screen.getByText(/YYYY-MM-DD HH:MM, in airport time/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('14. a layover that cannot take a report, with nothing remembered, renders nothing', async () => {
    const { view } = await mount({ canReport: false });
    expect(screen.queryByTestId('layover-disruption-card')).toBeNull();
    // Anti-vacuity: the same tree with a live session DOES draw the card, so the
    // null above is the card's decision and not an empty render.
    await view.rerender(
      <LayoverDisruptionCard sessionId="sess-1" canReport timezone="Asia/Bangkok" onReported={() => undefined} />,
    );
    expect(screen.getByTestId('layover-disruption-card')).toBeTruthy();
  });
});
