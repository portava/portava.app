/**
 * census-layover L132 / L166 / L277 — the crew location card.
 *
 *   - OFF on the server (`available: false`, or the route not there) draws
 *     NOTHING: no control for a capability that does not exist;
 *   - a share is Telegraph's scoped share: a label, a precision that opens on
 *     "Approximate area", a window from Telegraph's own list, and an end;
 *   - "Exact" is not offered until the SEPARATE control is on (L166), and the
 *     control starts off;
 *   - a picked plan stop's coordinates go only with venue/exact, never area;
 *   - crewmates' live shares are listed with a proximity BUCKET (L277);
 *   - "stop sharing" is one tap.
 *
 * Only `fetch` and the two auth modules beneath the real services are replaced.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverCrewLocationCard } from '../LayoverCrewLocationCard.tsx';

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

const ENDS = new Date(Date.now() + 3_600_000).toISOString();

function crewBody(over: Record<string, unknown> = {}) {
  return {
    ok: true, available: true, inCrew: true, crewId: 'crew-1', maxShareMinutes: 240, shareEndsBy: ENDS,
    preciseControl: { enabled: false }, mine: null, crewmatesWithheld: null,
    crewmates: [{
      userId: 'u-a', label: 'Night market', precision: 'venue', purpose: 'presence_in_context',
      sharedAt: new Date().toISOString(), endsAt: ENDS, position: null,
      ring: { center: { lat: 25.03, lng: 121.56 }, radiusMeters: 150 }, proximity: 'close', handle: 'ann', name: 'Ann',
    }],
    ...over,
  };
}

type Call = { url: string; method: string; body: any };

function route(handlers: { read?: () => unknown; stops?: unknown }) {
  const calls: Call[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/crew/location') && method === 'GET') return jsonResponse(200, handlers.read ? handlers.read() : crewBody());
    if (url.endsWith('/stops')) return jsonResponse(200, handlers.stops ?? { stops: [], planFit: null });
    return jsonResponse(200, { ok: true });
  });
  return calls;
}

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverCrewLocationCard', () => {
  it('1. the server says the capability is off: nothing is drawn', async () => {
    const calls = route({ read: () => ({ ok: true, available: false }) });
    const { toJSON } = await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByTestId('layover-crew-location')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('2. lists a crewmate\'s live share with its end and a proximity bucket — never a distance', async () => {
    route({});
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-mate-u-a')).toBeTruthy());
    expect(screen.getByText(/Night market/)).toBeTruthy();
    expect(screen.getByText(/Ann is close by/)).toBeTruthy();
    expect(screen.queryByText(/\d+ m\b/)).toBeNull();
  });

  it('3. "Exact" is not offered while the separate control is off, and the control starts off', async () => {
    route({});
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-share-open')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-location-precise-switch').props.value).toBe(false);
    await fireEvent.press(screen.getByTestId('layover-crew-location-share-open'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-precision-area')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-location-precision-area').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('layover-crew-location-precision-venue')).toBeTruthy();
    expect(screen.queryByTestId('layover-crew-location-precision-exact')).toBeNull();
  });

  it('4. turning the control on is its own PUT, and Exact appears only once the server says it is on', async () => {
    let enabled = false;
    const calls = route({ read: () => crewBody({ preciseControl: { enabled } }) });
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-precise-switch')).toBeTruthy());
    enabled = true;
    await fireEvent(screen.getByTestId('layover-crew-location-precise-switch'), 'valueChange', true);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/crew/location/precise-control'))).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ enabled: true });
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-precise-switch').props.value).toBe(true));
    await fireEvent.press(screen.getByTestId('layover-crew-location-share-open'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-precision-exact')).toBeTruthy());
  });

  it('5. a share sends a label, the precision, and an end inside the server ceiling — no coordinate at area', async () => {
    const calls = route({ stops: { stops: [{ id: 'st-1', title: 'Night market', lat: 25.03, lng: 121.56, insideAirport: false }], planFit: null } });
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-share-open')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-crew-location-share-open'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-pick-st-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-crew-location-pick-st-1'));
    await fireEvent.press(screen.getByTestId('layover-crew-location-duration-60'));
    const before = Date.now();
    await fireEvent.press(screen.getByTestId('layover-crew-location-send'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/api\/airport\/sessions\/sess-1\/crew\/location$/);
    expect(post.body.label).toBe('Night market');
    expect(post.body.precision).toBe('area');
    expect(post.body.lat).toBeUndefined();
    const ends = Date.parse(post.body.expiresAt);
    expect(ends - before).toBeGreaterThan(59 * 60_000);
    expect(ends - before).toBeLessThanOrEqual(60 * 60_000 + 5_000);
  });

  it('6. at venue precision the picked stop\'s coordinates go with it', async () => {
    const calls = route({ stops: { stops: [{ id: 'st-1', title: 'Night market', lat: 25.03, lng: 121.56, insideAirport: false }], planFit: null } });
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-share-open')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-crew-location-share-open'));
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-pick-st-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('layover-crew-location-pick-st-1'));
    await fireEvent.press(screen.getByTestId('layover-crew-location-precision-venue'));
    await fireEvent.press(screen.getByTestId('layover-crew-location-send'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ precision: 'venue', lat: 25.03, lng: 121.56 });
  });

  it('7. my live share shows its end, and stopping it is one DELETE', async () => {
    const calls = route({ read: () => crewBody({ mine: { userId: 'me', label: 'Gate B12', precision: 'area', sharedAt: new Date().toISOString(), endsAt: ENDS, position: null, ring: null, proximity: null } }) });
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-mine')).toBeTruthy());
    expect(screen.getByText(/Gate B12/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('layover-crew-location-stop'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('8. withheld crewmates are said to be withheld, not shown as nobody sharing', async () => {
    route({ read: () => crewBody({ crewmates: [], crewmatesWithheld: 'blocks_unreadable' }) });
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-withheld')).toBeTruthy());
    expect(screen.queryByText(/Nobody else in your crew is sharing/)).toBeNull();
  });

  it('9. an unreadable read says so', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, { error: 'degraded_unavailable', message: 'x' }));
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-location-unavailable')).toBeTruthy());
  });
});

describe('LayoverCrewLocationCard — the read it lands is the read the map gets', () => {
  it('10. onRead receives each landed read, and an inline handler does not cause a re-read loop', async () => {
    const calls = route({});
    const seen: unknown[] = [];
    await render(<LayoverCrewLocationCard sessionId="sess-1" timezone="UTC" onRead={(r) => { seen.push(r); }} />);
    await waitFor(() => expect(seen.length).toBe(1));
    expect((seen[0] as any).inCrew).toBe(true);
    expect((seen[0] as any).crewmates[0].userId).toBe('u-a');
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
  });
});
