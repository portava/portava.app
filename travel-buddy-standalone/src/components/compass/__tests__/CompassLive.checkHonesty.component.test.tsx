/**
 * TM-sense2 — the live check says what it could not read (census-compass §32).
 *
 * POST /compass/live/check adds `partial: true, failedSources: [...]` when a
 * Sense source (or the traveller's Sense settings) could not be read during
 * the tick; the server then delivers nothing from what it could not check. A
 * failed tick (5xx / network) used to vanish silently. This suite drives the
 * REAL service (services/compass.ts liveCall); only `fetch` is faked.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally minimal — CompassLive only uses useFocusEffect, and
// requireActual('expo-router') drags in native navigation internals that
// crash under jest-expo (same stand-in as CompassLive.component.test.tsx).
jest.mock('expo-router', () => {
  const ReactActual = require('react');
  return {
    useFocusEffect: (cb: () => void | (() => void)) => ReactActual.useEffect(cb, [cb]),
  };
});

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

// lib/supabase.ts reads the env at module load, so the service and the
// component are loaded after it is set.
const { CompassLive } = require('../CompassLive.tsx') as typeof import('../CompassLive.tsx');
const compassService = require('../../../services/compass.ts') as typeof import('../../../services/compass.ts');

const SESSION = {
  id: 'ls-1',
  status: 'active',
  context: { city: 'Hoi An', tripId: null, currentStop: null, nextItem: null, minutesToNext: null, recentEvents: [], updatedAt: new Date().toISOString() },
  checksRun: 1,
  nudgesDelivered: 0,
  startedAt: new Date().toISOString(),
};

type Reply = { status: number; body: unknown };
let checks = 0;
function serve(check: () => Reply) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    let r: Reply = { status: 404, body: { error: 'not_found' } };
    if (method === 'GET' && url === 'http://api.test/api/compass/live/session') r = { status: 200, body: { compassEnabled: true, active: true, session: SESSION } };
    if (method === 'POST' && url === 'http://api.test/api/compass/live/check') { checks += 1; r = check(); }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
}
const CLEAN: Reply = { status: 200, body: { compassEnabled: true, active: true, session: SESSION, evaluated: 0, delivered: [], suppressed: [] } };

beforeEach(() => { checks = 0; compassService._setTestAuthToken('tok'); });
afterEach(() => { compassService._setTestAuthToken(null); jest.restoreAllMocks(); });

describe('checkCompassLive carries the coverage keys', () => {
  it('healthy: no partial keys at all', async () => {
    serve(() => CLEAN);
    const r = await compassService.checkCompassLive();
    expect(r).toEqual({ ok: true, compassEnabled: true, active: true, session: SESSION, delivered: [], summary: null });
  });
  it('partial: the names the server gave', async () => {
    serve(() => ({ status: 200, body: { ...(CLEAN.body as object), partial: true, failedSources: ['settings'] } }));
    const r = await compassService.checkCompassLive();
    expect(r.partial).toBe(true);
    expect(r.failedSources).toEqual(['settings']);
  });
});

describe('CompassLive — a live check that could not read something says so', () => {
  it('a partial tick names what it could not read', async () => {
    serve(() => ({ status: 200, body: { ...(CLEAN.body as object), partial: true, failedSources: ['settings', 'circle_plan_change'] } }));
    const view = await render(<CompassLive />);
    await waitFor(() => expect(view.getByTestId('live-active')).toBeTruthy());
    const issue = await view.findByTestId('live-check-issue-text');
    expect(issue.props.children).toBe("The last live check couldn't read: your Sense settings, circle meetup changes. Nothing was sent from those, so this may not be everything.");
  });

  it('a failed tick is an error with Try again, and a clean retry clears it', async () => {
    let reply: Reply = { status: 503, body: { error: 'degraded_unavailable', message: 'Could not check right now.' } };
    serve(() => reply);
    const view = await render(<CompassLive />);
    await waitFor(() => expect(view.getByTestId('live-active')).toBeTruthy());
    const issue = await view.findByTestId('live-check-issue-text');
    expect(issue.props.children).toBe("Couldn't run the live check (http_503). Nothing was checked — this is not \"nothing happening\".");
    reply = CLEAN;
    fireEvent.press(view.getByTestId('live-check-retry'));
    await waitFor(() => expect(view.queryByTestId('live-check-issue')).toBeNull());
    expect(checks).toBe(2);
  });

  it('a clean tick shows no issue line', async () => {
    serve(() => CLEAN);
    const view = await render(<CompassLive />);
    await waitFor(() => expect(view.getByTestId('live-active')).toBeTruthy());
    await waitFor(() => expect(checks).toBe(1));
    expect(view.queryByTestId('live-check-issue')).toBeNull();
  });
});
