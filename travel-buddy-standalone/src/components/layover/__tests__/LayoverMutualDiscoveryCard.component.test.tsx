/**
 * census-layover L130 — L2 mutual discovery on the layover dashboard (LAYOVER 165, lane B2-CREW).
 *
 * The consent surface: ask one traveller by handle (one side's opt-in), answer a request (the other side's), see only
 * the travellers you BOTH agreed to, stop at once. Nothing is drawn when the feature is off; a traveller not sharing
 * their city is told why rather than shown an empty list; there is no "requests you sent" list. Only `fetch` and the
 * two auth modules beneath the real service are replaced.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverMutualDiscoveryCard } from '../LayoverMutualDiscoveryCard.tsx';

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

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
type Route = (url: string, init?: RequestInit) => Response;
const calls: Array<{ url: string; method: string; body: unknown }> = [];
function serve(route: Route) {
  calls.length = 0;
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return route(String(input), init);
  });
}
const SHARING = { ok: true, available: true, sharing: true, incoming: [], mutual: [], degraded: false };

afterEach(() => { jest.restoreAllMocks(); });

describe('LayoverMutualDiscoveryCard — L130 per-pair mutual consent', () => {
  it('1. feature off: draws nothing', async () => {
    serve(() => json(200, { ok: true, available: false }));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('layover-mutual-discovery')).toBeNull();
  });

  it('2. not sharing their city: says why, offers nothing to ask', async () => {
    serve(() => json(200, { ok: true, available: true, sharing: false, reason: 'sharing_off', incoming: [], mutual: [] }));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('layover-mutual-discovery-not-sharing')).toBeTruthy());
    expect(screen.queryByLabelText('Ask to see each other')).toBeNull();
  });

  it('3. asking sends ONE handle and shows the server\'s words — and there is no list of requests you sent', async () => {
    serve((url, init) => init?.method === 'POST' ? json(200, { ok: true, sent: true, message: 'If they are on a layover here and share their city, they will see your request. You will see each other only if they accept.' }) : json(200, SHARING));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(screen.getByLabelText("Traveller's handle")).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText("Traveller's handle"), '@ana_01');
    await fireEvent.press(screen.getByLabelText('Ask to see each other'));
    await waitFor(() => expect(screen.getByTestId('layover-mutual-discovery-notice')).toBeTruthy());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toMatch(/\/discovery\/requests$/);
    expect(post?.body).toEqual({ handle: '@ana_01' });
    expect(screen.getByText(/You will see each other only if they accept/)).toBeTruthy();
    expect(screen.queryByText(/sent/i)).toBeNull();
  });

  it('4. a request made to me: Agree is my explicit opt-in (accept), Decline declines', async () => {
    const incoming = [{ consentId: 'c-1', requestedAt: '2026-10-18T06:00:00Z', expiresAt: '2026-10-18T15:00:00Z', from: { id: 'u-ana', handle: 'ana', name: 'Ana', avatarUrl: null } }];
    serve((url, init) => init?.method === 'POST' ? json(200, { ok: true, status: url.endsWith('/accept') ? 'accepted' : 'declined' }) : json(200, { ...SHARING, incoming }));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('layover-discovery-incoming-c-1')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Agree to see Ana'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/discovery/c-1/accept'))).toBe(true));
    await fireEvent.press(screen.getByLabelText('Decline Ana'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/discovery/c-1/decline'))).toBe(true));
  });

  it('5. the people I see are ONLY the server\'s mutual list, each with an at-once revoke', async () => {
    const mutual = [{ id: 'u-ben', handle: 'ben', name: 'Ben', avatarUrl: null, consentId: 'c-9', expiresAt: '2026-10-18T15:00:00Z' }];
    serve((url, init) => init?.method === 'DELETE' ? json(200, { ok: true, status: 'revoked' }) : json(200, { ...SHARING, mutual }));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId('layover-discovery-mutual-u-ben')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Stop seeing Ben'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/discovery/c-9'))).toBe(true));
  });

  it('6. a failed read is said, never drawn as "nobody" — once the server has said the feature is on; before that, nothing', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const first = await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('layover-mutual-discovery')).toBeNull();
    await first.unmount();
    spy.mockReset();
    spy.mockResolvedValueOnce(json(200, SHARING)).mockRejectedValue(new TypeError('Network request failed'));
    const view = await render(<LayoverMutualDiscoveryCard sessionId="s1" refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('You have not agreed to see anyone here.')).toBeTruthy());
    await view.rerender(<LayoverMutualDiscoveryCard sessionId="s1" refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId('layover-mutual-discovery-failed')).toBeTruthy());
    expect(screen.queryByText('You have not agreed to see anyone here.')).toBeNull();
  });

  it('7. a 404 from a server without the route draws nothing', async () => {
    serve(() => json(404, { error: 'not_found' }));
    await render(<LayoverMutualDiscoveryCard sessionId="s1" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('layover-mutual-discovery')).toBeNull();
  });
});
