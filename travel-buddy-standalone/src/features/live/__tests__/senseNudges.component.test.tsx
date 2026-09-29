/**
 * TM-live (WP-11) COMP-F11 — Compass Sense check and nudges, through the REAL
 * service (senseNudges.ts → liveApi.ts). Only `fetch` is faked, answering by
 * URL the way routes/compassSense.ts does; the token comes from the helper's
 * test seam.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { SenseNudgesPanel } from '../SenseNudgesPanel.tsx';
import { useSenseAutoCheck, senseLocationKey, SENSE_MOVE_MIN_INTERVAL_MS } from '../useSenseAutoCheck.ts';
import { runSenseCheck } from '../senseNudges.ts';
import { _setLiveTestToken } from '../liveApi.ts';

const { router } = require('expo-router');

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function serve(route: (url: string, method: string) => { status: number; body: unknown } | undefined) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = route(url, method) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
}
const NUDGE = { id: 'n1', type: 'saved_event_starting', category: 'events', title: 'Saved event starting soon', body: 'Jazz night starts at 20:00.', actionUrl: '/event/e1', confidence: null, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() };

beforeEach(() => { calls = []; _setLiveTestToken(async () => 'tok'); jest.spyOn(router, 'push').mockImplementation(() => {}); });
afterEach(() => { _setLiveTestToken(null); jest.restoreAllMocks(); });

describe('COMP-F11 SenseNudgesPanel', () => {
  it('lists the nudges Sense delivered and opens the one tapped', async () => {
    serve((url, m) => (m === 'GET' && url === 'http://api.test/api/compass/sense/nudges' ? { status: 200, body: { compassEnabled: true, nudges: [NUDGE] } } : undefined));
    const { findByTestId, getByText } = await render(<SenseNudgesPanel />);
    fireEvent.press(await findByTestId('sense-nudge-n1'));
    expect(getByText('Jazz night starts at 20:00.')).toBeTruthy();
    expect(router.push).toHaveBeenCalledWith('/event/e1');
  });

  it('a failed nudge read says so with Try again — never "no nudges"', async () => {
    let fail = true;
    serve((url, m) => (m === 'GET' && url.endsWith('/compass/sense/nudges')
      ? (fail ? { status: 503, body: { error: 'degraded_unavailable', message: 'Your nudges could not be read' } } : { status: 200, body: { compassEnabled: true, nudges: [] } })
      : undefined));
    const { findByTestId, queryByTestId, getByTestId, getByText } = await render(<SenseNudgesPanel />);
    expect(await findByTestId('sense-nudges-unavailable')).toBeTruthy();
    expect(queryByTestId('sense-nudges-empty')).toBeNull();
    // An outage is "couldn't load", never "the server refused" — the two send a tester to fix different things.
    expect(getByText(/^Couldn't load your nudges — Your nudges could not be read\. This is not an empty answer/)).toBeTruthy();
    fail = false;
    fireEvent.press(getByTestId('sense-nudges-retry'));
    expect(await findByTestId('sense-nudges-empty')).toBeTruthy();
  });

  it('Check now runs the server check, says what it delivered and held back, and re-reads the list', async () => {
    serve((url, m) => {
      if (m === 'POST' && url.endsWith('/compass/sense/check')) {
        return { status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 2, delivered: [NUDGE], suppressed: [{ dedupeKey: 'k', type: 'weather_change', reason: 'quiet_hours' }] } };
      }
      if (m === 'GET' && url.endsWith('/compass/sense/nudges')) return { status: 200, body: { compassEnabled: true, nudges: [NUDGE] } };
      return undefined;
    });
    const { findByTestId, getByTestId, findByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudge-n1');
    fireEvent.press(getByTestId('sense-check-now'));
    await findByTestId('sense-check-result');
    expect(await findByText('1 nudge delivered; 1 held back.')).toBeTruthy();
    expect(await findByText(/weather change held back — quiet hours/)).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2));
  });

  it('a failed check says it failed; zero delivered never claims there was nothing to find', async () => {
    let ok = false;
    serve((url, m) => {
      if (m === 'POST' && url.endsWith('/compass/sense/check')) return ok ? { status: 200, body: { compassEnabled: true, presenceLevel: 'aware', evaluated: 0, delivered: [], suppressed: [] } } : { status: 500, body: { error: 'db_error' } };
      if (m === 'GET') return { status: 200, body: { compassEnabled: true, nudges: [] } };
      return undefined;
    });
    const { findByTestId, getByTestId, findByText, queryByText } = await render(<SenseNudgesPanel />);
    await findByTestId('sense-nudges-empty');
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByTestId('sense-check-failed')).toBeTruthy();
    ok = true;
    fireEvent.press(getByTestId('sense-check-now'));
    expect(await findByText('No nudge was delivered on this check.')).toBeTruthy();
    expect(queryByText(/nothing to nudge/i)).toBeNull();
  });

  it('Compass off renders nothing', async () => {
    serve(() => ({ status: 200, body: { compassEnabled: false, fallback: true } }));
    const { toJSON, queryByTestId } = await render(<SenseNudgesPanel />);
    await waitFor(() => expect(queryByTestId('sense-nudges-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });
});

describe('COMP-F11 useSenseAutoCheck — who asks Sense to look', () => {
  function Probe(p: { enabled: boolean; locationKey: string | null; now: () => number }) {
    useSenseAutoCheck({ ...p, run: runSenseCheck });
    return null;
  }
  it('checks on mount, and again when the traveller moves (after the move interval); never when signed out', async () => {
    serve((url, m) => (m === 'POST' && url.endsWith('/compass/sense/check') ? { status: 200, body: { compassEnabled: true, presenceLevel: 'active', evaluated: 1, delivered: [], suppressed: [] } } : undefined));
    let t = 1_000_000;
    const now = () => t;
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === 'http://api.test/api/compass/sense/check').length;

    const out = await render(<Probe enabled={false} locationKey="16.07,108.22" now={now} />);
    expect(posts()).toBe(0);
    await out.rerender(<Probe enabled locationKey="16.07,108.22" now={now} />);
    await waitFor(() => expect(posts()).toBe(1));
    t += 30_000; // moved too soon: throttled
    await out.rerender(<Probe enabled locationKey="16.10,108.30" now={now} />);
    expect(posts()).toBe(1);
    t += SENSE_MOVE_MIN_INTERVAL_MS;
    await out.rerender(<Probe enabled locationKey="10.78,106.70" now={now} />);
    await waitFor(() => expect(posts()).toBe(2));
  });
  it('senseLocationKey: ~1 km cells from coordinates, else the city, else nothing', () => {
    expect(senseLocationKey({ coords: { latitude: 16.06781, longitude: 108.22083 } })).toBe('16.07,108.22');
    expect(senseLocationKey({ coords: null, place: { city: 'Da Nang' } })).toBe('city:Da Nang');
    expect(senseLocationKey(null)).toBeNull();
  });
});
