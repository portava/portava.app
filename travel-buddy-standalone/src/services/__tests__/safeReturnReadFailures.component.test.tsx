/**
 * A Safe Return / layover read that FAILED is "we could not check", never
 * "you have none".
 *
 * THE DEFECTS.
 *   1. `getActiveSession` / `getHistory` went through `apiFetch`, which hands
 *      back the body of ANY response. The server's 503 `degraded_unavailable`
 *      (artifacts/api-server/src/routes/safeReturn.ts — "We could not check
 *      whether you have a Safe Return running") therefore arrived as
 *      `{ session: null }` / `{ sessions: [] }`: "no Safe Return running" while
 *      a timer was running, and "No Safe Return history yet".
 *   2. `useSafeReturnActive` took that null at its word and switched the
 *      capture prompts back on during a live session (the IG spec forbids any
 *      capture prompt while Safe Return is active).
 *   3. LayoverSessionProvider read `getActiveLayoverSession()`'s `null` (which
 *      it returns for any non-2xx, e.g. a 503) as "no layover", and the active
 *      layover pill vanished.
 *
 * Only `fetch` is faked for the service half; the hook and the provider run
 * for real against a mocked read.
 *
 * RED on the tree before this change: 5 failed / 1 passed (the "a real empty
 * answer stays empty" guard is green on both).
 *
 * Two renders only (RNTL v14 + React 19 render-count limit).
 */
import React from 'react';
import { Text, Pressable } from 'react-native';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the services under test only import it.
jest.mock('../../lib/supabase', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: intentionally exhaustive — the token helper is the only export used.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok' }));

const mockGetActiveSession = jest.fn();
jest.mock('../safeReturn', () => ({
  ...jest.requireActual('../safeReturn'),
  getActiveSession: (...a: unknown[]) => mockGetActiveSession(...a),
}));

const mockGetActiveLayover = jest.fn();
// NOTE: intentionally exhaustive — LayoverSessionContext imports only this
// function (and types) from the 3,000-line layover service.
jest.mock('../layover', () => ({
  getActiveLayoverSession: (...a: unknown[]) => mockGetActiveLayover(...a),
}));

// NOTE: intentionally exhaustive — the provider only uses useFocusEffect. Here a
// "focus" follows every commit, so a second read happens right after the first
// lands, the way a returning traveller re-focuses the tab.
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    const R = require('react');
    R.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; });
  },
}));

import { useSafeReturnActive } from '../../hooks/useSafeReturnActive.ts';
import { LayoverSessionProvider, useLayoverSessionContext } from '../../context/LayoverSessionContext.tsx';

const real = jest.requireActual('../safeReturn') as typeof import('../safeReturn.ts');
const fetchMock = jest.fn();

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); jest.clearAllMocks(); });

const unavailable503 = { ok: false, status: 503, json: async () => ({ error: 'degraded_unavailable', message: 'We could not check whether you have a Safe Return running. Please try again.', retryable: true }) };

describe('safeReturn service — a failed read says so', () => {
  it('getActiveSession: a 503 is `unavailable`, not "no session"', async () => {
    fetchMock.mockResolvedValue(unavailable503);
    expect(await real.getActiveSession()).toEqual({ session: null, unavailable: true });
  });

  it('getHistory: a 503 is `unavailable`, not "no history"', async () => {
    fetchMock.mockResolvedValue(unavailable503);
    const r = await real.getHistory(50);
    expect(r.unavailable).toBe(true);
  });

  it('a real empty answer stays empty (and is not marked unavailable)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ session: null }) });
    expect(await real.getActiveSession()).toEqual({ session: null, featureEnabled: undefined });
  });
});

describe('consumers keep what they last knew when a read fails', () => {
  it('useSafeReturnActive: a live session stays live through a failed refresh', async () => {
    const live = { id: 's1', status: 'active' };
    mockGetActiveSession
      .mockResolvedValueOnce({ session: live })
      .mockResolvedValueOnce({ session: null, unavailable: true });
    function Probe() {
      const s = useSafeReturnActive(true);
      return (
        <Pressable testID="refresh" onPress={s.refresh}>
          <Text testID="active">{String(s.active)}</Text>
        </Pressable>
      );
    }
    await render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('active').props.children).toBe('true'));
    await act(async () => { fireEvent.press(screen.getByTestId('refresh')); });
    await waitFor(() => expect(mockGetActiveSession).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByTestId('active').props.children).toBe('true');
  });

  it('LayoverSessionProvider: the active layover does not vanish when a re-read fails', async () => {
    mockGetActiveLayover
      .mockResolvedValueOnce({ session: { id: 'lay-1', status: 'active' } })
      .mockResolvedValue(null);
    function Pill() {
      const { session } = useLayoverSessionContext();
      return <Text testID="layover">{session?.id ?? 'none'}</Text>;
    }
    await render(<LayoverSessionProvider><Pill /></LayoverSessionProvider>);
    await waitFor(() => expect(mockGetActiveLayover.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(screen.getByTestId('layover').props.children).toBe('lay-1');
  });

  it('LayoverSessionProvider: a THROWN re-read (no signal / airplane mode) keeps the layover too', async () => {
    // authedFetch does not catch, so a network failure rejects rather than resolving null (verifier, 2026-10-22).
    mockGetActiveLayover
      .mockResolvedValueOnce({ session: { id: 'lay-1', status: 'active' } })
      .mockRejectedValue(new TypeError('Network request failed'));
    function Pill() {
      const { session } = useLayoverSessionContext();
      return <Text testID="layover">{session?.id ?? 'none'}</Text>;
    }
    await render(<LayoverSessionProvider><Pill /></LayoverSessionProvider>);
    await waitFor(() => expect(mockGetActiveLayover.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(screen.getByTestId('layover').props.children).toBe('lay-1');
  });

  it('LayoverSessionProvider: a REAL "no active layover" answer still clears it', async () => {
    mockGetActiveLayover
      .mockResolvedValueOnce({ session: { id: 'lay-1', status: 'active' } })
      .mockResolvedValue({ session: null });
    function Pill() {
      const { session } = useLayoverSessionContext();
      return <Text testID="layover">{session?.id ?? 'none'}</Text>;
    }
    await render(<LayoverSessionProvider><Pill /></LayoverSessionProvider>);
    await waitFor(() => expect(mockGetActiveLayover.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(screen.getByTestId('layover').props.children).toBe('none');
  });
});

describe('the trip screens poll through a failed read without clearing the card', () => {
  // Source-level: neither screen mounts cheaply here; the hook above pins the behaviour, this pins the wiring.
  it('app/trip/[id].tsx and TripPlanSection skip an `unavailable` answer instead of storing `session: null`', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const root = join(__dirname, '../../..');
    const trip = readFileSync(join(root, 'app/trip/[id].tsx'), 'utf8');
    const plan = readFileSync(join(root, 'src/features/trips/planning/TripPlanSection.tsx'), 'utf8');
    expect(trip).toMatch(/const r = await getActiveSession\(\);\s*\n\s*if \(cancelled \|\| r\.unavailable\) return;/);
    expect(plan).toMatch(/const r = await getActiveSession\(\);\s*\n\s*if \(cancelled \|\| r\.unavailable\) return;/);
    expect(plan).toMatch(/\.then\(\(r\) => \{ if \(!r\.unavailable\) setActiveSafeReturnSession\(r\.session\); \}\)/);
  });
});
