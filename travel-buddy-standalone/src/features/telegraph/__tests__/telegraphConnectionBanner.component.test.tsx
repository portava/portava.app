/**
 * Telegraph §30A.15 — the banner, driven by the REAL messaging transport.
 *
 * Before this, a thread or an inbox that could not reach the server looked
 * exactly like a quiet one: the polls swallowed their failures and the realtime
 * status was rendered nowhere. These cases make the transport fail the way a
 * phone in a tunnel does — `fetch` rejecting with "Network request failed" —
 * and assert the banner says so, then says it is coming back, then goes away.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time, which fails outside an Expo runtime.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the service reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto; none of
// the calls under test touches them.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(), establishE2ee: jest.fn(), decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(), E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));

const mockStatus = { listeners: new Set<(s: string) => void>(), current: 'idle' };
// NOTE: intentionally exhaustive — the monitor reads only the status feed.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: () => () => {},
    onStatus: (l: (s: string) => void) => { mockStatus.listeners.add(l); l(mockStatus.current); return () => { mockStatus.listeners.delete(l); }; },
    getStatus: () => mockStatus.current,
  },
}));

import { getMyThreads, markThreadRead, updateMyLanguageSettings } from '../../../services/messaging.ts';
import { TelegraphConnectionBanner } from '../connection/TelegraphConnectionBanner.tsx';
import { _resetConnectionMonitor } from '../connection/connectionMonitor.ts';

const realFetch = global.fetch;
function stream(s: string) {
  mockStatus.current = s;
  for (const l of [...mockStatus.listeners]) l(s);
}
function failNetwork() {
  global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
}
function answer(status: number) {
  global.fetch = jest.fn(async () => ({ ok: status < 300, status, json: async () => ({ threads: [] }) }) as Response) as typeof fetch;
}

beforeEach(() => {
  _resetConnectionMonitor();
  mockStatus.listeners.clear();
  mockStatus.current = 'idle';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
});

describe('TelegraphConnectionBanner', () => {
  it('draws nothing while requests are answered and the stream is open', async () => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    answer(200);
    await act(async () => { await getMyThreads(); });
    expect(screen.toJSON()).toBeNull();
  });

  it("THE POINT: two unanswered requests say Portava can't be reached — a silent inbox is not a quiet one", async () => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    failNetwork();
    await act(async () => { await getMyThreads(); await getMyThreads(); });
    expect(screen.getByTestId('telegraph-connection-OFFLINE')).toBeTruthy();
    expect(screen.getByText(/Can't reach Portava/)).toBeTruthy();
  });

  it('then RECONNECTING once requests are answered again, then nothing once the stream is back', async () => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    failNetwork();
    await act(async () => { await getMyThreads(); await getMyThreads(); stream('connecting'); });
    expect(screen.getByTestId('telegraph-connection-OFFLINE')).toBeTruthy();
    answer(200);
    await act(async () => { await getMyThreads(); });
    expect(screen.getByTestId('telegraph-connection-RECONNECTING')).toBeTruthy();
    await act(async () => {
      stream('open');
      for (let i = 0; i < 6; i++) await getMyThreads(); // the failures age out of the window
    });
    expect(screen.toJSON()).toBeNull();
  });

  it('the FIRST connect is not a reconnect; a drop after the stream had been open is', async () => {
    await render(<TelegraphConnectionBanner />);
    answer(200);
    await act(async () => { stream('connecting'); await getMyThreads(); });
    expect(screen.toJSON()).toBeNull();
    await act(async () => { stream('open'); });
    await act(async () => { stream('connecting'); });
    expect(screen.getByTestId('telegraph-connection-RECONNECTING')).toBeTruthy();
  });

  it('a refused request (403) is an ANSWER — no banner for it', async () => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    answer(403);
    await act(async () => { await getMyThreads(); await getMyThreads(); });
    expect(screen.toJSON()).toBeNull();
  });

  it('a run of 5xx says the server is having trouble, not that the device is offline', async () => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    answer(503);
    await act(async () => { await getMyThreads(); await getMyThreads(); });
    expect(screen.getByTestId('telegraph-connection-POOR_CONNECTION')).toBeTruthy();
    expect(screen.getByText(/Portava is having trouble/)).toBeTruthy();
    expect(screen.queryByText(/Can't reach Portava/)).toBeNull();
  });

  // Every transport verb reports — not only reads. A send that cannot reach the
  // server is the case the person most needs told about.
  it.each([
    ['a POST', () => markThreadRead('11111111-1111-4111-8111-111111111111')],
    ['a PATCH', () => updateMyLanguageSettings({ autoTranslate: true } as any)],
  ])('%s that gets no answer counts as unanswered', async (_n, call) => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    failNetwork();
    await act(async () => { await call(); await call(); });
    expect(screen.getByTestId('telegraph-connection-OFFLINE')).toBeTruthy();
  });

  it.each([
    ['a POST', () => markThreadRead('11111111-1111-4111-8111-111111111111')],
    ['a PATCH', () => updateMyLanguageSettings({ autoTranslate: true } as any)],
  ])('%s answered 5xx is the server failing; answered 403 is an answer', async (_n, call) => {
    await render(<TelegraphConnectionBanner />);
    await act(async () => { stream('open'); });
    answer(403);
    await act(async () => { await call(); await call(); });
    expect(screen.toJSON()).toBeNull();
    answer(503);
    await act(async () => { await call(); await call(); });
    expect(screen.getByText(/Portava is having trouble/)).toBeTruthy();
  });
});
