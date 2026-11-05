import { freshToken } from '../../apiToken.ts';
import { dubbingAudioSource, getDubbingConsent, getDubbingOptions, requestDubbing, revokeDubbing } from '../dubbing.ts';

jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));
import { setDiscoveryViewerFromSession } from '../../discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, observedOwnerSession, emitObservedAuthEvent } from '../../__tests__/observedOwnerSessionFixture.ts';

jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: {
    listeners,
    onAuthStateChange: (listener: unknown) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
  } } };
});


const userId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const identity = { userId, assetId };
const sessionId = 'dubbing-session';
const token = observedOwnerAccessToken(userId, sessionId);
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const mockFetch = jest.fn();
const response = (status = 200, json: unknown = {}) => ({ status, ok: status >= 200 && status < 300, redirected: false, url: `https://app.example/api/media/${assetId}/dubbing/audio?language=en-US`, headers: { get: (name: string) => ({ 'content-type': 'audio/wav', 'x-ai-generated': 'synthetic-dubbing', 'cache-control': 'private, no-store', 'content-length': '48044' }[name.toLowerCase()] ?? null) }, json: async () => json });

beforeEach(() => {
  jest.clearAllMocks(); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://app.example';
  global.fetch = mockFetch;
  setDiscoveryViewerFromSession(userId);
  seedObservedOwnerSession(userId, sessionId);
  jest.mocked(freshToken).mockReset().mockResolvedValue(token);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(response());
});
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); jest.useRealTimers(); });
afterAll(() => { global.fetch = originalFetch; if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase; });

it('preflights only authenticated same-origin private audio with a fresh token', async () => {
  const source = await dubbingAudioSource(identity, 'en-US', new AbortController().signal);
  expect(source).toEqual({ uri: `https://app.example/api/media/${assetId}/dubbing/audio?language=en-US`, headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' }, overrideFileExtensionAndroid: 'wav' });
  expect(mockFetch).toHaveBeenCalledWith(source.uri, expect.objectContaining({ method: 'HEAD', redirect: 'error', cache: 'no-store', headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }));
});

it('rejects untrusted base URLs and malformed identifiers without transmitting credentials', async () => {
  for (const base of ['http://provider.example', 'https://user:secret@app.example', 'https://app.example/other', 'file:///local']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    await expect(dubbingAudioSource(identity, 'en-US')).rejects.toThrow();
  }
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://app.example';
  await expect(dubbingAudioSource({ ...identity, assetId: '../private' }, 'en-US')).rejects.toThrow();
  await expect(dubbingAudioSource(identity, 'en-US&x=1')).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('refuses missing authentication and account changes around token refresh', async () => {
  jest.mocked(freshToken).mockResolvedValue(null);
  await expect(dubbingAudioSource(identity, 'en-US')).rejects.toThrow('authentication_required');
  seedObservedOwnerSession(userId, sessionId);
  jest.mocked(freshToken).mockImplementation(async () => {
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(assetId, 'replacement'));
    return 'other-account-token';
  });
  await expect(dubbingAudioSource(identity, 'en-US')).rejects.toThrow('authentication_required');
  expect(mockFetch).not.toHaveBeenCalled();
});

it('refuses redirects, unlabelled/public data and denied audio', async () => {
  for (const changed of [{ redirected: true }, { url: 'https://other.example/audio.wav' }, { headers: { get: () => null } }, { status: 403, ok: false }]) {
    mockFetch.mockResolvedValue({ ...response(), ...changed });
    await expect(dubbingAudioSource(identity, 'en-US')).rejects.toThrow();
  }
});

it('aborted admission does not fetch and a stale completed request cannot return a source', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(dubbingAudioSource(identity, 'en-US', controller.signal)).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
  mockFetch.mockImplementation(async () => { emitObservedAuthEvent('SIGNED_OUT', null); return response(); });
  await expect(dubbingAudioSource(identity, 'en-US')).rejects.toThrow('authentication_required');
});

it('creator state requires the exact label/disclosure and sends an explicit revision-bound grant', async () => {
  const state = { consentRevision: 'a'.repeat(64), optedIn: false, label: 'AI-generated translated audio', disclosureVersion: 'synthetic-dubbing-v1' };
  mockFetch.mockResolvedValue({ ...response(200, state), url: '' });
  expect(await getDubbingConsent(identity, 'en-US')).toEqual(state);
  mockFetch.mockResolvedValue({ ...response(202, { jobId: assetId, status: 'queued', label: state.label, originalPreserved: true }), url: '' });
  await requestDubbing(identity, 'en-US', state.consentRevision, true);
  expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body)).toEqual({ targetLanguage: 'en-US', expectedConsentRevision: state.consentRevision, explicitOptIn: true, disclosureVersion: 'synthetic-dubbing-v1' });
  await expect(requestDubbing(identity, 'en-US', state.consentRevision, false)).rejects.toThrow();
});

it('withdrawal is not gated on generation readiness and preserves cleanup failures', async () => {
  mockFetch.mockResolvedValue({ ...response(204), url: '' });
  await revokeDubbing(identity);
  expect(mockFetch.mock.calls.at(-1)![1].method).toBe('DELETE');
  mockFetch.mockResolvedValue({ ...response(503, { error: 'cleanup_failed' }), url: '' });
  await expect(revokeDubbing(identity)).rejects.toThrow('cleanup_failed');
});

it('a withdrawn epoch is submitted unchanged and never automatically refreshed or retried', async () => {
  const captured = 'e'.repeat(64);
  mockFetch.mockResolvedValue({ ...response(409, { error: 'source_revoked' }), url: '' });
  await expect(requestDubbing(identity, 'en-US', captured, true)).rejects.toThrow('stale_consent');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).expectedConsentRevision).toBe(captured);
});

it('playback options reject wrong sources, invented readiness and leaked configuration', async () => {
  const value = { assetId, sourceVersion: 1, sourceKey: 'a'.repeat(64), canEdit: true, enabled: false, languages: [{ code: 'en', label: 'English', ready: false }] };
  mockFetch.mockResolvedValue({ ...response(200, value), url: '' });
  expect(await getDubbingOptions(identity)).toEqual(value);
  expect(mockFetch.mock.calls.at(-1)![0]).toBe(`https://app.example/api/media/${assetId}/dubbing/options`);
  for (const invalid of [{ ...value, assetId: userId }, { ...value, modelPath: '/private/model' }, { ...value, languages: [{ code: 'en', label: 'English', ready: 'yes' }] }]) {
    mockFetch.mockResolvedValue({ ...response(200, invalid), url: '' });
    await expect(getDubbingOptions(identity)).rejects.toThrow();
  }
});

for (const stage of ['token', 'headers', 'body']) {
  it(`bounds stalled dubbing ${stage} and never accepts late completion`, async () => {
    jest.useFakeTimers();
    let finishToken!: (value: string) => void;
    if (stage === 'token') jest.mocked(freshToken).mockReturnValueOnce(new Promise((resolve) => { finishToken = resolve; }));
    if (stage === 'headers') mockFetch.mockImplementationOnce(() => new Promise(() => {}));
    if (stage === 'body') mockFetch.mockResolvedValueOnce({ ...response(), url: '', json: () => new Promise(() => {}) });
    const failed = expect(getDubbingConsent(identity, 'en')).rejects.toThrow('unavailable');
    await jest.advanceTimersByTimeAsync(15001);
    await failed;
    if (stage === 'token') {
      finishToken(token); await Promise.resolve(); await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    } else expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
}

for (const replacement of ['new session', 'logout then original session']) {
  it(`refuses a pending dubbing write after ${replacement} for the same account`, async () => {
    let finish!: (value: string) => void;
    jest.mocked(freshToken).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = requestDubbing(identity, 'en', 'a'.repeat(64), true);
    const failed = expect(pending).rejects.toThrow('authentication_required');
    if (replacement === 'logout then original session') emitObservedAuthEvent('SIGNED_OUT', null);
    const nextSession = replacement === 'new session' ? 'replacement-session' : sessionId;
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(userId, nextSession));
    finish(observedOwnerAccessToken(userId, nextSession));
    await failed;
    expect(mockFetch).not.toHaveBeenCalled();
  });
}

it('rejects a decoded dubbing response after logout', async () => {
  mockFetch.mockResolvedValueOnce({ ...response(), url: '', json: async () => {
    emitObservedAuthEvent('SIGNED_OUT', null);
    return { consentRevision: 'a'.repeat(64), optedIn: false, label: 'AI-generated translated audio', disclosureVersion: 'synthetic-dubbing-v1' };
  } });
  await expect(getDubbingConsent(identity, 'en')).rejects.toThrow('authentication_required');
});
