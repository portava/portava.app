/**
 * census-layover L27 / L129 / L187 — the client half of presence intents.
 *
 * Pinned: the surface exists only when the server says so; others are COUNTS,
 * never people; a failed read is a failure with a retry, never "nobody is open";
 * a failed save keeps the selection and says it did not save; clearing every
 * chip clears the record rather than saving an empty one.
 *
 * Only `fetch` and the two auth modules beneath it are replaced.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverPresenceIntents, describeIntentCounts } from '../LayoverPresenceIntents.tsx';
import { getPresenceIntents } from '../../../services/layover.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// D-PRESENCE-K: the server withholds every count below 5 (zero included) as null.
const COUNTS = { food: 6, nightlife: 5, shopping: null, culture: null, meetups: null };
const OWN = { intents: ['food'], availableUntil: '2026-10-05T20:00:00.000Z', availableFrom: '2026-10-05T12:00:00.000Z', maxTravelMinutes: null };

let fetchSpy: jest.SpyInstance;
afterEach(() => { jest.restoreAllMocks(); });

function route(handler: (url: string, init?: RequestInit) => Response) {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (u: any, i?: any) => handler(String(u), i));
}
const calls = (method: string) => fetchSpy.mock.calls.filter(([, i]: any[]) => (i?.method ?? 'GET') === method);

describe('getPresenceIntents — OFF, FAILED and COUNTS stay distinct', () => {
  test('1. the surface OFF is available:false', async () => {
    route(() => jsonResponse(200, { ok: true, available: false, own: null, counts: null }));
    expect(await getPresenceIntents('s-1')).toEqual({ ok: true, available: false });
  });
  test('2. a partial counts object is a contract mismatch, not zeros', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: { food: 2 } }));
    expect((await getPresenceIntents('s-1')).ok).toBe(false);
  });
  test('3. a 503 keeps the server sentence', async () => {
    route(() => jsonResponse(503, { error: 'degraded_unavailable', message: 'Your intents could not be loaded. Please try again.' }));
    expect(await getPresenceIntents('s-1')).toEqual({ ok: false, reason: 'unavailable', message: 'Your intents could not be loaded. Please try again.' });
  });
});

describe('describeIntentCounts', () => {
  test('4. only counts of at least 5, in vocabulary order; nothing to show is null', () => {
    expect(describeIntentCounts(COUNTS)).toBe('6 open to food · 5 open to nightlife');
    expect(describeIntentCounts({ food: null, nightlife: null, shopping: null, culture: null, meetups: null })).toBeNull();
    expect(describeIntentCounts(null)).toBeNull();
  });
  test('4b. D-PRESENCE-K: a count below 5 from an older server is never rendered', () => {
    expect(describeIntentCounts({ food: 2, nightlife: 1, shopping: 0, culture: 4, meetups: 5 })).toBe('5 open to meetups');
  });
  test('4c. a withheld (null) count parses; it is not a contract mismatch', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: COUNTS, minimumCount: 5 }));
    const r = await getPresenceIntents('s-1');
    expect(r.ok && r.available && r.counts).toEqual(COUNTS);
  });
});

describe('LayoverPresenceIntents', () => {
  test('5. the server says OFF: nothing renders', async () => {
    route(() => jsonResponse(200, { ok: true, available: false, own: null, counts: null }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.queryByTestId('layover-intents-loading')).toBeNull());
    expect(screen.queryByTestId('layover-intents')).toBeNull();
    expect(screen.queryByTestId('layover-intents-unavailable')).toBeNull();
  });

  test('6. counts are shown as counts, and the own selection is pre-ticked', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: OWN, counts: COUNTS }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intents')).toBeTruthy());
    expect(String(screen.getByTestId('layover-intents-others').props.children)).toBe('6 open to food · 5 open to nightlife');
    expect(screen.getByTestId('layover-intent-food').props.accessibilityState).toEqual({ checked: true });
    expect(screen.getByTestId('layover-intent-culture').props.accessibilityState).toEqual({ checked: false });
    expect(screen.queryByTestId('layover-intents-save')).toBeNull();
  });

  test('7. ticking a chip and saving PUTs the selection in vocabulary order, then re-reads', async () => {
    let saved = false;
    route((url, init) => {
      if (init?.method === 'PUT') { saved = true; return jsonResponse(200, { ok: true, own: { ...OWN, intents: ['food', 'culture'] } }); }
      return jsonResponse(200, { ok: true, available: true, own: saved ? { ...OWN, intents: ['food', 'culture'] } : OWN, counts: COUNTS });
    });
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intent-culture')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intent-culture')); });
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intents-save')); });
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0][1].body))).toEqual({ intents: ['food', 'culture'] });
    await waitFor(() => expect(screen.queryByTestId('layover-intents-save')).toBeNull());
  });

  test('8. un-ticking everything clears the record (DELETE), it does not save an empty one', async () => {
    route((url, init) => init?.method === 'DELETE'
      ? jsonResponse(200, { ok: true, own: null })
      : jsonResponse(200, { ok: true, available: true, own: OWN, counts: COUNTS }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intent-food')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intent-food')); });
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intents-save')); });
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('PUT')).toHaveLength(0);
  });

  test('9. a failed save keeps the selection on screen and says it did not save', async () => {
    route((url, init) => init?.method === 'PUT'
      ? jsonResponse(409, { error: 'conflict', reason: 'sharing_off', message: 'Turn on sharing your city first.' })
      : jsonResponse(200, { ok: true, available: true, own: null, counts: COUNTS }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intent-meetups')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intent-meetups')); });
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intents-save')); });
    await waitFor(() => expect(screen.getByTestId('layover-intents-notice')).toBeTruthy());
    expect(String(screen.getByTestId('layover-intents-notice').props.children)).toBe('Turn on sharing your city first.');
    expect(screen.getByTestId('layover-intent-meetups').props.accessibilityState).toEqual({ checked: true });
  });

  test('10. a failed read is a failure with a retry, never "nobody is open"', async () => {
    route(() => jsonResponse(503, { error: 'degraded_unavailable', message: 'Intents nearby could not be loaded. Please try again.' }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intents-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('layover-intents-others')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId('layover-intents-retry')); });
    await waitFor(() => expect(calls('GET').length).toBeGreaterThanOrEqual(2));
  });

  test('11. counts withheld (not sharing) is said as such, not as "nobody"', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: null, countsWithheld: 'sharing_off' }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intents-others')).toBeTruthy());
    expect(String(screen.getByTestId('layover-intents-others').props.children)).toMatch(/Share your city to see/);
  });

  test('11b. every count withheld (below 5) says "fewer than 5", never "nobody"', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: { food: null, nightlife: null, shopping: null, culture: null, meetups: null } }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intents-others')).toBeTruthy());
    const text = String(screen.getByTestId('layover-intents-others').props.children);
    expect(text).toMatch(/Fewer than 5 people/);
    expect(text).not.toMatch(/Nobody/);
  });

  test('11c. counts withheld beside a named roster says so', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: null, countsWithheld: 'roster_visible' }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit />);
    await waitFor(() => expect(screen.getByTestId('layover-intents-others')).toBeTruthy());
    expect(String(screen.getByTestId('layover-intents-others').props.children)).toMatch(/listed by name/);
  });

  test('12. a viewer who cannot edit sees the counts and no chips', async () => {
    route(() => jsonResponse(200, { ok: true, available: true, own: null, counts: COUNTS }));
    await render(<LayoverPresenceIntents sessionId="s-1" canEdit={false} />);
    await waitFor(() => expect(screen.getByTestId('layover-intents-others')).toBeTruthy());
    expect(screen.queryByTestId('layover-intent-food')).toBeNull();
  });
});
