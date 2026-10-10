/**
 * Telegraph §17.4 — census-telegraph T239: a slow SERVER is not a slow CONNECTION.
 *
 * §45.3 kept T239 W because "the signal cannot separate a slow network from a slow server": the
 * transport timed whole requests, so a server taking three seconds shed typing, previews and AI from
 * a person on good wifi. The API now stamps `Server-Timing: app;dur=<ms>` on every answer
 * (middlewares/telegraphObservability.ts, proved in the api-server suite telegraphServerTiming), and
 * the transport hands the monitor only the NETWORK share. These cases drive the REAL transport
 * (`getMyThreads` → apiGet) and the REAL monitor; only fetch and the clock are stubbed.
 *
 * Reactions, the other half of §45.3's reason: Telegraph has no reaction affordance to shed (pinned in
 * safetyModeEntertainment.component.test.tsx for the thread screen); the ladder's `reactions` class
 * stays declared for when one exists.
 */
// NOTE: intentionally exhaustive — lib/supabase builds a client at import time,
// which fails outside an Expo runtime. The transport reads only these names.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: {},
  isSupabaseConfigured: true,
}));
// NOTE: intentionally exhaustive — the transport reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: async () => 'tok-1',
}));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto; no call here touches them.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(),
  establishE2ee: jest.fn(),
  decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(),
  E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));

import { MIN_SAMPLES, SLOW_REQUEST_MS, networkDurationMs, serverDurationMs } from '../connection/bandwidthSignal.ts';
import { _resetConnectionMonitor, currentBandwidth } from '../connection/connectionMonitor.ts';
import { getMyThreads } from '../../../services/messaging.ts';

const TOTAL = SLOW_REQUEST_MS + 1500; // every answer takes this long, end to end

describe('T239 — the Server-Timing header, read', () => {
  it('serverDurationMs reads app;dur and nothing else', () => {
    expect(serverDurationMs('app;dur=3800')).toBe(3800);
    expect(serverDurationMs('db;dur=5, app;dur=12.5')).toBe(12.5);
    expect(serverDurationMs('app;desc="x";dur="40"')).toBe(40);
    expect(serverDurationMs('edge;dur=7')).toBeNull();
    expect(serverDurationMs('app;dur=fast')).toBeNull();
    expect(serverDurationMs('')).toBeNull();
    expect(serverDurationMs(null)).toBeNull();
  });

  it('networkDurationMs: the total less the server share; the whole total when the server says nothing; never negative', () => {
    expect(networkDurationMs(4000, 'app;dur=3800')).toBe(200);
    expect(networkDurationMs(4000, null)).toBe(4000);
    expect(networkDurationMs(4000, 'edge;dur=3800')).toBe(4000);
    expect(networkDurationMs(100, 'app;dur=500')).toBe(0);
  });
});

describe('T239 — the transport hands the monitor the NETWORK share', () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });
  beforeEach(() => { _resetConnectionMonitor(); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });

  async function answersTaking(serverTiming: string | null) {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'server-timing' ? serverTiming : null) },
      json: async () => ({ threads: [] }),
    }) as unknown as Response) as typeof fetch;
    let clock = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      clock += TOTAL; // consecutive reads are TOTAL apart, so each answer took TOTAL end to end
      return clock;
    });
    try {
      for (let i = 0; i < MIN_SAMPLES; i++) await getMyThreads();
    } finally {
      nowSpy.mockRestore();
    }
  }

  it('slow because the SERVER was slow: the connection is NOT constrained', async () => {
    await answersTaking(`app;dur=${TOTAL - 100}`);
    expect(currentBandwidth()).toEqual({ signal: 'normal', cause: null });
  });

  it('slow because the NETWORK was slow (the server was quick): constrained', async () => {
    await answersTaking('app;dur=15');
    expect(currentBandwidth()).toEqual({ signal: 'constrained', cause: 'slow_responses' });
  });

  it('no header (an older server, or a proxy that strips it): counted whole, as before', async () => {
    await answersTaking(null);
    expect(currentBandwidth()).toEqual({ signal: 'constrained', cause: 'slow_responses' });
  });
});
