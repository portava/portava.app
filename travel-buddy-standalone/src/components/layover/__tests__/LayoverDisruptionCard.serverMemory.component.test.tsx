/**
 * LayoverDisruptionCard — census-layover L148 (round 2): a reload shows the
 * SERVER's memory of the flight.
 *
 * The overview now carries `disruption` (read from the ledger POST /:id/disruption
 * writes), and the screen hands it to the card AS SENT. These cases drive the
 * REAL card over the REAL services: only `fetch`, the token helper and
 * AsyncStorage (jest's in-memory mock) stand in.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   1  a reload that shows this phone's copy when the server says otherwise —
 *      the server's state, its recorded time and its recovery posture win;
 *   2  a phone copy shown when the server says NOTHING was reported;
 *   3  an unreadable server memory rendered as "nothing reported", or the phone's
 *      copy shown without saying the server could not be read;
 *   4  an ended layover with a recorded disruption showing nothing (or controls);
 *   5  a report from another device, recorded after this phone's press, not
 *      replacing the press's answer — or a stale read replacing it.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LayoverDisruptionCard } from '../LayoverDisruptionCard.tsx';
import { rememberDisruption, type DisruptionAnswer } from '../../../services/layoverDisruption.ts';

// NOTE: intentional stub — the real helper reads a Supabase session through the
// native SecureStore adapter; a fixed token is all the disruption wire needs.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

const NO_HELP = {
  rebooking: { available: false, reason: 'no_airline_integration' },
  airlineContact: { available: false, reason: 'no_airline_directory' },
  airportHelp: { available: false, reason: 'no_airport_help_directory' },
};

const T1 = '2026-09-08T10:00:00.000Z';
const T2 = '2026-09-08T10:20:00.000Z';

/** The overview member exactly as `overviewDisruption` (routes/airport.ts) writes it. */
function known(state: string, recordedAt: string | null, source: 'ledger' | 'default' = 'ledger') {
  return {
    status: 'known', state, source, reportedBy: source === 'ledger' ? 'traveller' : null, recordedAt,
    baselineDepartureTime: null,
    recovery: { recoveryNeeded: ['CANCELLED', 'REBOOKING', 'SEVERE_DELAY', 'OVERNIGHT'].includes(state), ...NO_HELP },
  };
}
const UNKNOWN = {
  status: 'unknown', reason: 'ledger_unreadable',
  message: 'Portava could not read this flight\'s disruption history just now, so it cannot say whether a delay or cancellation was reported.',
};

/** A recorded answer as the route returns it — what the phone keeps. */
function recorded(state: string, previousState = 'CONNECTION'): DisruptionAnswer {
  return {
    source: 'traveller', previousState, previousStateSource: previousState === 'CONNECTION' ? 'default' : 'ledger', state,
    event: { kind: state === 'CANCELLED' ? 'cancellation' : 'delay', delayMinutes: state === 'DELAYED' ? 60 : null },
    baselineDepartureTime: null, stateRecorded: true, recompute: null,
    recovery: { recoveryNeeded: state === 'CANCELLED', ...NO_HELP }, safeReturn: null, certification: null,
  };
}

let answers: unknown[] = [];
let posts: unknown[] = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  answers = [];
  posts = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    if (!/\/disruption$/.test(url)) throw new Error(`test: unexpected request ${url}`);
    posts.push(JSON.parse(String(init.body)));
    const body = answers.shift();
    if (!body) throw new Error('test: no server answer queued');
    return { ok: true, status: 200, json: async () => body };
  });
});

function props(over: Partial<React.ComponentProps<typeof LayoverDisruptionCard>> = {}): React.ComponentProps<typeof LayoverDisruptionCard> {
  return { sessionId: 'sess-1', canReport: true, timezone: 'UTC', departureLocal: '2026-09-08 23:00', onReported: jest.fn(), ...over };
}

/** Let the card's AsyncStorage read land before asserting what it chose. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('L148 — the reload shows the SERVER\'s memory', () => {
  it('1. server CANCELLED (recorded from any device) beats this phone\'s DELAYED copy: state, recorded time, recovery, rebooking next', async () => {
    await rememberDisruption('sess-1', recorded('DELAYED'));
    await render(<LayoverDisruptionCard {...props({ serverDisruption: known('CANCELLED', T1) })} />);
    await settle();

    expect(screen.getByTestId('layover-disruption-server-status')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-state-DELAYED')).toBeNull();
    expect(screen.queryByTestId('layover-disruption-remembered')).toBeNull();
    expect(screen.getByTestId('layover-disruption-server-recorded').props.children).toMatch(/as Portava recorded it at 10:00(\s?AM)? — from this phone or any other/);
    expect(screen.getByText('Source: your report. Portava has no flight feed.')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-recovery')).toBeTruthy();
    expect(screen.getByText(/Rebooking: unavailable — Portava has no connection to any airline/)).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-report-rebooking_offered')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-controls')).toBeNull();
  });

  it('2. the server says NOTHING was reported: this phone\'s CANCELLED copy is not shown, and the flight reports are offered', async () => {
    await rememberDisruption('sess-1', recorded('CANCELLED'));
    await render(<LayoverDisruptionCard {...props({ serverDisruption: known('CONNECTION', null, 'default') })} />);
    await settle();

    expect(screen.queryByTestId('layover-disruption-state-CANCELLED')).toBeNull();
    expect(screen.queryByTestId('layover-disruption-remembered')).toBeNull();
    expect(screen.queryByTestId('layover-disruption-status')).toBeNull();
    expect(screen.getByTestId('layover-disruption-controls')).toBeTruthy();
  });
});

describe('L148 — an unreadable server memory is UNKNOWN, and only then does the phone\'s copy show', () => {
  it('3. unknown + a phone copy: the copy, captioned as this phone\'s, AND the sentence that the server could not be read', async () => {
    await rememberDisruption('sess-1', recorded('CANCELLED'));
    await render(<LayoverDisruptionCard {...props({ serverDisruption: UNKNOWN })} />);

    await waitFor(() => expect(screen.getByTestId('layover-disruption-remembered')).toBeTruthy());
    expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-server-unknown').props.children).toBe(UNKNOWN.message);
  });

  it('4. unknown + nothing on this phone: the card says it does not know — no state, never "on schedule"', async () => {
    await render(<LayoverDisruptionCard {...props({ serverDisruption: UNKNOWN })} />);
    await settle();

    expect(screen.getByTestId('layover-disruption-server-unknown')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-state-CONNECTION')).toBeNull();
    expect(screen.queryByText('On schedule')).toBeNull();
    expect(screen.getByTestId('layover-disruption-controls')).toBeTruthy();
  });

  it('4b. an older server that sends no member: the phone\'s copy, captioned, with NO claim that the server failed', async () => {
    await rememberDisruption('sess-1', recorded('CANCELLED'));
    await render(<LayoverDisruptionCard {...props()} />);

    await waitFor(() => expect(screen.getByTestId('layover-disruption-remembered')).toBeTruthy());
    expect(screen.queryByTestId('layover-disruption-server-unknown')).toBeNull();
  });
});

describe('L148 — an ended layover', () => {
  it('5. a recorded disruption on an ended layover is still shown — read-only, no reports offered', async () => {
    await render(<LayoverDisruptionCard {...props({ canReport: false, serverDisruption: known('CANCELLED', T1) })} />);
    await settle();
    expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-next')).toBeNull();
    expect(screen.queryByTestId('layover-disruption-controls')).toBeNull();
  });

  it('5b. an ended layover nobody reported on draws no card at all (control)', async () => {
    await render(<LayoverDisruptionCard {...props({ canReport: false, serverDisruption: known('CONNECTION', null, 'default') })} />);
    await settle();
    expect(screen.queryByTestId('layover-disruption-card')).toBeNull();
  });
});

describe('L148 — a press in this mount, and what may replace its answer', () => {
  const cancelled = {
    ok: true,
    disruption: { source: 'traveller', previousState: 'DELAYED', previousStateSource: 'ledger', state: 'CANCELLED', event: { kind: 'cancellation' }, baselineDepartureTime: null, stateRecorded: true },
    recompute: null, recovery: { recoveryNeeded: true, ...NO_HELP }, safeReturn: null, certification: null,
  };

  async function pressCancel(p: React.ComponentProps<typeof LayoverDisruptionCard>) {
    answers.push(cancelled);
    const view = await render(<LayoverDisruptionCard {...p} />);
    await settle();
    await fireEvent.press(screen.getByTestId('layover-disruption-report-cancellation'));
    await fireEvent.press(screen.getByTestId('layover-disruption-confirm-cancellation'));
    await waitFor(() => expect(screen.getByTestId('layover-disruption-previous')).toBeTruthy());
    return view;
  }

  it('6. the re-read that catches up with the press (same state, later row) keeps the press\'s fuller answer', async () => {
    const p = props({ serverDisruption: known('DELAYED', T1) });
    const view = await pressCancel(p);
    expect(posts).toEqual([{ kind: 'cancellation' }]);
    await view.rerender(<LayoverDisruptionCard {...p} serverDisruption={known('CANCELLED', T2)} />);
    expect(screen.getByTestId('layover-disruption-previous')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
  });

  it('7. a read already in flight at the press (the OLD row) cannot put the old state back', async () => {
    const p = props({ serverDisruption: known('DELAYED', T2) });
    const view = await pressCancel(p);
    await view.rerender(<LayoverDisruptionCard {...p} serverDisruption={known('DELAYED', T1)} />);
    expect(screen.getByTestId('layover-disruption-state-CANCELLED')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-state-DELAYED')).toBeNull();
  });

  it('8. a LATER report from another device, in another state, replaces the press\'s answer with the server\'s', async () => {
    const p = props({ serverDisruption: known('DELAYED', T1) });
    const view = await pressCancel(p);
    await view.rerender(<LayoverDisruptionCard {...p} serverDisruption={known('REBOOKING', T2)} />);
    expect(screen.getByTestId('layover-disruption-state-REBOOKING')).toBeTruthy();
    expect(screen.getByTestId('layover-disruption-server-status')).toBeTruthy();
    expect(screen.queryByTestId('layover-disruption-previous')).toBeNull();
  });
});
