const mockStorage = new Map<string, string>();
// NOTE: exhaustive deterministic storage boundary shared across simulated module restarts.
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: async (key: string) => mockStorage.get(key) ?? null, setItem: async (key: string, value: string) => { mockStorage.set(key, value); } }));
// NOTE: exhaustive-by-design network/auth boundary: this service uses only configuration and freshToken; importing the real Supabase client would start native auth timers.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));
jest.mock('../../apiToken.ts', () => ({ freshToken: jest.fn() }));
import { freshToken } from '../../apiToken.ts';
import { setDiscoveryViewerFromSession } from '../../discoveryViewerScope.ts';
import { readSensingConsent, setSensingConsent, onSensingConsentChange } from '../../sensingConsent.ts';
import { SENSING_CONSENT_WORDS } from '../../../lib/sensing/consentSplit.ts';
const token = freshToken as jest.Mock;
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function response() { return { ok: true, json: async () => ({ available: true, consents: ['capture', 'upload', 'surface'].map(scope => ({ scope, granted: true, effective: true, current: true, currentVersion: 'v' })) }) } as Response; }
beforeEach(() => { setDiscoveryViewerFromSession(`a-${expect.getState().currentTestName}`); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'; token.mockReset().mockResolvedValue('synthetic-token'); fetchMock = jest.fn(async () => response()); global.fetch = fetchMock; });
afterEach(() => { global.fetch = originalFetch; });
it('a grant awaiting auth cannot be dispatched for the account selected later', async () => {
  const auth = deferred<string>(); token.mockReturnValue(auth.promise);
  const pending = setSensingConsent('capture', true, SENSING_CONSENT_WORDS.capture.version);
  setDiscoveryViewerFromSession('b'); auth.resolve('b-token');
  expect((await pending).ok).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
});
it('a late consent read is unreadable for the replacement account', async () => {
  const res = deferred<Response>(); fetchMock.mockReturnValue(res.promise);
  const pending = readSensingConsent(); await Promise.resolve();
  setDiscoveryViewerFromSession('b'); res.resolve(response());
  expect((await pending).status).toBe('unreadable');
});
it('a late saved result cannot notify or update the replacement account', async () => {
  const res = deferred<Response>(); fetchMock.mockReturnValue(res.promise); const listener = jest.fn(); const unsubscribe = onSensingConsentChange(listener);
  const pending = setSensingConsent('capture', false, SENSING_CONSENT_WORDS.capture.version); await Promise.resolve();
  setDiscoveryViewerFromSession('b'); res.resolve(response());
  expect((await pending).ok).toBe(false); expect(listener).toHaveBeenCalledTimes(1); unsubscribe();
});
it('signed-out callers cannot send an unauthenticated consent mutation', async () => {
  setDiscoveryViewerFromSession(null);
  expect((await setSensingConsent('capture', true, SENSING_CONSENT_WORDS.capture.version)).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('withdrawal pauses the current phone before a delayed request finishes and remains denied if the request fails', async () => {
  const network = deferred<Response>(); fetchMock.mockReturnValueOnce(network.promise);
  const listener = jest.fn(); const unsubscribe = onSensingConsentChange(listener);
  const pending = setSensingConsent('upload', false, SENSING_CONSENT_WORDS.upload.version);
  expect(listener).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  network.resolve({ ok: false, status: 503 } as Response);
  expect((await pending).ok).toBe(false);
  const read = await readSensingConsent();
  expect(read.status).toBe('ok');
  if (read.status === 'ok') {
    expect(read.state.consents.capture.effective).toBe(true);
    expect(read.state.consents.upload.effective).toBe(false);
    expect(read.state.consents.surface.effective).toBe(false);
    expect(read.state.localWithdrawalPending).toContain('upload');
  }
  unsubscribe();
});
it('a recorded withdrawal hold remains denied after the hold module reloads', async () => {
  const owner = 'u:durable-hold-owner';
  const { holdSensingWithdrawal } = require('../withdrawalHold.ts') as typeof import('../withdrawalHold.ts');
  await holdSensingWithdrawal(owner, 'capture');
  let fresh!: typeof import('../withdrawalHold.ts');
  jest.isolateModules(() => { fresh = require('../withdrawalHold.ts'); });
  expect(await fresh.readSensingWithdrawalHolds(owner)).toEqual(['capture']);
});

it('a stalled settings read times out and can be retried without changing consent', async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const waiting = readSensingConsent();
    await jest.advanceTimersByTimeAsync(10_001);
    expect(await waiting).toEqual({ status: 'unreadable', reason: 'network' });
    expect((await readSensingConsent()).status).toBe('ok');
  } finally { jest.useRealTimers(); }
});
