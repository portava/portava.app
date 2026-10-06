/**
 * Telegraph §2.1 — census T8 (re-verification R4, 2026-10-06): the inbox is a
 * tab and stays MOUNTED, so its NOW and UPCOMING bands must move with the clock.
 *
 * THE DEFECT. The bands were fetched once, at mount, and NOW / UPCOMING were
 * decided against the clock of that moment. The minute tick re-checked only the
 * status line. Three hours into the evening, with the tab never unmounted, a
 * five-minute-old session was still NOW and a plan that had started was still
 * UPCOMING — four requests, all at mount, and nothing after.
 *
 * Pinned: the bands keep what the server ANSWERED and re-decide NOW / UPCOMING
 * against the clock on every render (the minute tick is a render), with no
 * request per tick; and a mounted inbox re-asks on a bounded interval, so a
 * session or plan that began after mount reaches it.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the reads take one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { InboxContextBands } from '../inbox/InboxContextBands.tsx';
import { INBOX_BANDS_REFRESH_MS } from '../inbox/inboxBandsApi.ts';

const START = Date.parse('2026-10-05T18:00:00.000Z');
const iso = (msFromStart: number) => new Date(START + msFromStart).toISOString();
const realFetch = global.fetch;

type Answers = { sessions: unknown[]; meetups: unknown[] };
function serve(answers: Answers) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.includes('/me/quick-availability') ? { status: null, expiresAt: null }
      : u.includes('/nearby/reachable') ? { enabled: false, people: [] }
      : u.includes('/me/coordination-sessions') ? { sessions: answers.sessions }
      : { meetups: answers.meetups };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  return global.fetch as jest.Mock;
}
const session = (startedMsFromStart: number) => ({ sessionId: 's1', threadId: 'th1', title: 'Dinner', state: 'ACTIVE', endedAt: null, startedAt: iso(startedMsFromStart), transitions: [] });
const plan = (startsMsFromStart: number) => ({ id: 'm1', title: 'Hoi An', startsAt: iso(startsMsFromStart), status: 'active', chatThreadId: 'th2', myRsvp: 'going' });

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
afterAll(() => { global.fetch = realFetch; });

describe('R4: the clock moves the bands, not a request', () => {
  const realNow = Date.now;
  let clock = START;
  beforeEach(() => { clock = START; Date.now = () => clock; });
  afterEach(() => { Date.now = realNow; });

  it('the verifier’s probe: three hours later, a 5-minute-old session is no longer NOW and a started plan no longer UPCOMING', async () => {
    const fetchMock = serve({ sessions: [session(-5 * 60_000)], meetups: [plan(30 * 60_000)] });
    const { rerender } = await render(<InboxContextBands />);
    await waitFor(() => expect(screen.queryByTestId('telegraph-band-now')).toBeTruthy());
    expect(screen.queryByTestId('telegraph-band-upcoming')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    clock += 3 * 3_600_000; // the evening passes; the tab never unmounts
    await rerender(<InboxContextBands />); // what the minute tick does
    expect(screen.queryByTestId('telegraph-band-now')).toBeNull();
    expect(screen.queryByTestId('telegraph-band-upcoming')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // re-decided, not re-asked
  });

  it('the plan’s time words move too: "in 30 min" becomes "in 10 min"', async () => {
    serve({ sessions: [], meetups: [plan(30 * 60_000)] });
    const { rerender } = await render(<InboxContextBands />);
    expect(await screen.findByText('Hoi An · in 30 min')).toBeTruthy();
    clock += 20 * 60_000;
    await rerender(<InboxContextBands />);
    expect(screen.getByText('Hoi An · in 10 min')).toBeTruthy();
  });
});

describe('R4: a mounted inbox re-asks on a bounded interval', () => {
  beforeEach(() => { jest.useFakeTimers({ now: START }); });
  afterEach(() => { jest.useRealTimers(); });

  it('ticks make no request; after the interval the four reads run again, and a session opened since mount is NOW', async () => {
    const answers: Answers = { sessions: [], meetups: [] };
    const fetchMock = serve(answers);
    await render(<InboxContextBands />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.queryByTestId('telegraph-band-now')).toBeNull();

    // A crewmate opens a session after the inbox was mounted.
    answers.sessions = [session(5 * 60_000)];
    await act(async () => { jest.advanceTimersByTime(INBOX_BANDS_REFRESH_MS - 60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4); // minute ticks only — no request per tick
    expect(screen.queryByTestId('telegraph-band-now')).toBeNull();

    await act(async () => { jest.advanceTimersByTime(60_000); });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(screen.getByTestId('telegraph-band-now-s1')).toBeTruthy();
  });

  it('the interval is bounded: at least five minutes, at most an hour', () => {
    expect(INBOX_BANDS_REFRESH_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(INBOX_BANDS_REFRESH_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
