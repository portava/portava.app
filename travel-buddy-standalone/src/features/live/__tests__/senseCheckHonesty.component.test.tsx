/**
 * TM-sense2 — the Sense check says which checks could not run (census-compass §32).
 *
 * The server now names unread sources (census-compass §30/§32):
 *   POST /compass/sense/check  200 { …, partial: true, failedSources: [...] }
 *                              503 { error: "degraded_unavailable", …, failedSources: [...] }
 * This suite drives the REAL service (senseNudges.ts → liveApi.ts); only
 * `fetch` is faked, answering the way routes/compassSense.ts does.
 *
 *  - a partial 200 says which checks could not run, next to what was delivered;
 *  - a 503 is an error with Try again — never "nothing to nudge you about";
 *  - the auto-check never records a failed or partial check as a clean one:
 *    the throttle that follows a clean check does not hide a failure.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { AppState } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

import { SenseNudgesPanel } from '../SenseNudgesPanel.tsx';
import { useSenseAutoCheck, SENSE_FOREGROUND_MIN_INTERVAL_MS } from '../useSenseAutoCheck.ts';
import { runSenseCheck } from '../senseNudges.ts';
import { _setLiveTestToken } from '../liveApi.ts';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

type Reply = { status: number; body: unknown };
let posts = 0;
function serve(check: () => Reply) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    let r: Reply = { status: 404, body: { error: 'not_found' } };
    if (method === 'POST' && url === 'http://api.test/api/compass/sense/check') { posts += 1; r = check(); }
    if (method === 'GET' && url === 'http://api.test/api/compass/sense/nudges') r = { status: 200, body: { compassEnabled: true, nudges: [] } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
}

const NUDGE = { type: 'saved_event_starting', category: 'events', title: 'Saved event starting soon', body: 'Jazz night starts at 20:00.', actionUrl: '/event/e1' };
const CLEAN: Reply = { status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 1, delivered: [NUDGE], suppressed: [] } };
const PARTIAL: Reply = { status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 1, delivered: [NUDGE], suppressed: [], partial: true, failedSources: ['circle_plan_change', 'weather_change'] } };
const UNAVAILABLE: Reply = {
  status: 503,
  body: {
    error: 'degraded_unavailable',
    message: 'Compass could not read any of the signals it checks right now. Please try again shortly.',
    retryable: true,
    failedSources: ['saved_event_starting', 'leave_earlier', 'weather_change', 'circle_plan_change', 'free_time_block'],
  },
};

beforeEach(() => { posts = 0; _setLiveTestToken(async () => 'tok'); });
afterEach(() => { _setLiveTestToken(null); jest.restoreAllMocks(); });

describe('runSenseCheck reads the coverage keys', () => {
  it('a healthy check has no failed sources', async () => {
    serve(() => CLEAN);
    const r = await runSenseCheck();
    expect(r.state === 'ok' && r.value.failedSources).toEqual([]);
  });
  it('a partial check carries the names the server gave', async () => {
    serve(() => PARTIAL);
    const r = await runSenseCheck();
    expect(r.state === 'ok' && r.value.failedSources).toEqual(['circle_plan_change', 'weather_change']);
  });
  it('a 503 is unavailable and still names what could not be read', async () => {
    serve(() => UNAVAILABLE);
    const r = await runSenseCheck();
    expect(r.state).toBe('unavailable');
    expect(r.state === 'unavailable' && r.failedSources).toEqual(['saved_event_starting', 'leave_earlier', 'weather_change', 'circle_plan_change', 'free_time_block']);
  });
});

describe('SenseNudgesPanel — Check now is honest about what could not run', () => {
  it('a partial 200 says which checks could not run, next to what was delivered', async () => {
    serve(() => PARTIAL);
    const { findByTestId, getByTestId, findByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByText('1 nudge delivered.')).toBeTruthy();
    const line = await findByTestId('sense-check-partial');
    expect(line.props.children).toBe("Some checks couldn't run: circle meetup changes, weather for today's plans. Nothing from them is included above — this is not everything.");
  });

  it('a partial 200 with nothing delivered never reads as "nothing to nudge you about"', async () => {
    serve(() => ({ status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 0, delivered: [], suppressed: [], partial: true, failedSources: ['leave_earlier'] } }));
    const { findByTestId, getByTestId, findByText, queryByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByText('No nudge was delivered on this check.')).toBeTruthy();
    expect((await findByTestId('sense-check-partial')).props.children).toMatch(/^Some checks couldn't run: route timing \(leave earlier\)\./);
    expect(queryByText(/nothing to nudge/i)).toBeNull();
  });

  it('an unread daily count is named, and the held-back line says why', async () => {
    serve(() => ({ status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 1, delivered: [], suppressed: [{ dedupeKey: 'k', type: 'saved_event_starting', reason: 'daily_cap_unread' }], partial: true, failedSources: ['nudge_log'] } }));
    const { findByTestId, getByTestId, findByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByText(/saved event starting held back — today's nudge count couldn't be read, so nothing was sent/)).toBeTruthy();
    expect((await findByTestId('sense-check-partial')).props.children).toMatch(/today's nudge count/);
  });

  it('a 503 is an error with Try again that names the checks — and Try again runs the check', async () => {
    let reply = UNAVAILABLE;
    serve(() => reply);
    const { findByTestId, getByTestId, findByText, queryByTestId, queryByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    const failed = await findByTestId('sense-check-failed');
    expect(failed).toBeTruthy();
    expect(await findByText(/^Couldn't load the Sense check — Compass could not read any of the signals/)).toBeTruthy();
    expect(await findByText("Couldn't run: saved events starting soon, route timing (leave earlier), weather for today's plans, circle meetup changes, free time in your day.")).toBeTruthy();
    expect(queryByTestId('sense-check-result')).toBeNull();
    expect(queryByText(/nothing to nudge|No nudge was delivered/i)).toBeNull();
    reply = CLEAN;
    fireEvent.press(getByTestId('sense-check-retry'));
    expect(await findByText('1 nudge delivered.')).toBeTruthy();
    expect(posts).toBe(2);
    expect(queryByTestId('sense-check-failed')).toBeNull();
  });

  it('an unread presence setting (503, settings) is named as the settings', async () => {
    serve(() => ({ status: 503, body: { error: 'degraded_unavailable', message: 'Compass could not read any of the signals it checks right now. Please try again shortly.', retryable: true, failedSources: ['settings'] } }));
    const { findByTestId, getByTestId, findByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByText("Couldn't run: your Sense settings.")).toBeTruthy();
    expect(getByTestId('sense-check-retry')).toBeTruthy();
  });
});

describe('useSenseAutoCheck — a failed or partial check is not recorded as clean', () => {
  function Probe(p: { now: () => number }) {
    useSenseAutoCheck({ enabled: true, locationKey: '16.07,108.22', now: p.now, run: runSenseCheck });
    return null;
  }
  let foreground: ((s: string) => void) | null = null;
  beforeEach(() => {
    foreground = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: (s: string) => void) => { foreground = h; return { remove: () => {} }; }) as any);
  });
  async function backToForeground() { await act(async () => { foreground?.('active'); }); }

  it('after a CLEAN check, returning a minute later is throttled (the 10-minute rule stands)', async () => {
    serve(() => CLEAN);
    let t = 5_000_000;
    await render(<Probe now={() => t} />);
    await waitFor(() => expect(posts).toBe(1));
    t += 61_000;
    await backToForeground();
    expect(posts).toBe(1);
    t += SENSE_FOREGROUND_MIN_INTERVAL_MS;
    await backToForeground();
    await waitFor(() => expect(posts).toBe(2));
  });

  it('after a FAILED check (503), returning a minute later asks again instead of hiding the failure for 10 minutes', async () => {
    let reply = UNAVAILABLE;
    serve(() => reply);
    let t = 5_000_000;
    await render(<Probe now={() => t} />);
    await waitFor(() => expect(posts).toBe(1));
    reply = CLEAN;
    t += 61_000;
    await backToForeground();
    await waitFor(() => expect(posts).toBe(2));
  });

  it('after a PARTIAL check, returning a minute later asks again', async () => {
    let reply = PARTIAL;
    serve(() => reply);
    let t = 5_000_000;
    await render(<Probe now={() => t} />);
    await waitFor(() => expect(posts).toBe(1));
    reply = CLEAN;
    t += 61_000;
    await backToForeground();
    await waitFor(() => expect(posts).toBe(2));
    // …and once it is clean again, the ordinary throttle returns.
    t += 61_000;
    await backToForeground();
    expect(posts).toBe(2);
  });

  it('a failure is retried no faster than once a minute', async () => {
    serve(() => UNAVAILABLE);
    let t = 5_000_000;
    await render(<Probe now={() => t} />);
    await waitFor(() => expect(posts).toBe(1));
    t += 20_000;
    await backToForeground();
    expect(posts).toBe(1);
  });
});
