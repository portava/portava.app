import { setDiscoveryViewerFromSession } from '../../discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent } from '../../__tests__/observedOwnerSessionFixture.ts';

// NOTE: exhaustive auth-emitter fixture; keeps the real owner/session guard without constructing a native Supabase client.
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
const ownerId = '10000000-0000-4000-a000-000000000001';
const sessionId = 'caption-session';
const token = observedOwnerAccessToken(ownerId, sessionId);

import { freshToken } from '../../apiToken.ts';
import { getImageUnderstandingStatus, requestImageUnderstanding, revokeImageUnderstanding, readImageUnderstanding } from '../imageUnderstanding.ts';

jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));

const id = '20000000-0000-4000-a000-000000000001';
const status = { postMediaId: id, sourceVersion: 7, mediaType: 'image' as const, consent: 'none' as const,
  processing: { enabled: true, provider: 'huggingface' as const, policyVersion: 'hf-siglip-v1-reviewed', disclosure: 'Use the dedicated Hugging Face endpoint.' } };
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const reply = (value: unknown = status, extra: Partial<Response> = {}) => ({ ok: true, status: 200, redirected: false, url: '', json: async () => value, ...extra } as Response);
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  setDiscoveryViewerFromSession(ownerId); seedObservedOwnerSession(ownerId, sessionId);
  jest.mocked(freshToken).mockResolvedValue(token);
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply());
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
  jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers();
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('binds requests to the reviewed source and named provider and supports withdrawal without enabled flags', async () => {
  const reviewed = await getImageUnderstandingStatus(id);
  jest.mocked(fetch).mockResolvedValueOnce(reply({ accepted: true, state: 'queued', verified: false }));
  await requestImageUnderstanding(reviewed);
  const options = jest.mocked(fetch).mock.calls.at(-1)![1]!;
  expect(JSON.parse(options.body as string)).toEqual({ sourceVersion: 7, policyVersion: 'hf-siglip-v1-reviewed', scope: 'media_image_understanding', processingProvider: 'huggingface' });
  expect(options).toEqual(expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }));
  jest.mocked(fetch).mockResolvedValueOnce(reply(null, { status: 204 }));
  await revokeImageUnderstanding(id);
  expect(jest.mocked(fetch).mock.calls.at(-1)![1]!.method).toBe('DELETE');
});

it('refuses unsafe origins, unexpected providers and contradictory policy receipts', async () => {
  for (const base of ['http://api.test', 'https://api.test@evil.test', 'https://api.test/path', 'https://api.test?x=y']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    await expect(getImageUnderstandingStatus(id)).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  for (const processing of [{ ...status.processing, provider: 'unknown' }, { ...status.processing, policyVersion: 'local-v1' }, { ...status.processing, policyVersion: null }]) {
    jest.mocked(fetch).mockResolvedValueOnce(reply({ ...status, processing }));
    await expect(getImageUnderstandingStatus(id)).rejects.toThrow(/disclosure/);
  }
});

it('bounds token and body waits, and never returns another session’s result', async () => {
  jest.useFakeTimers(); jest.mocked(freshToken).mockImplementationOnce(() => new Promise(() => {}));
  const waiting = expect(getImageUnderstandingStatus(id)).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(10001); await waiting;
  expect(fetch).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  jest.mocked(fetch).mockResolvedValueOnce(reply(null, { json: () => new Promise(resolve => { finish = resolve; }) }));
  const pending = expect(getImageUnderstandingStatus(id)).rejects.toThrow(/session changed/);
  await jest.advanceTimersByTimeAsync(0);
  emitObservedAuthEvent('SIGNED_OUT', null);
  finish(status); await pending;
  expect(jest.getTimerCount()).toBe(0);
});

it('refuses redirects, unavailable responses and stale or identity-like suggestions', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(reply(status, { redirected: true }));
  await expect(getImageUnderstandingStatus(id)).rejects.toThrow(/redirected/);
  jest.mocked(fetch).mockResolvedValueOnce(reply({}, { ok: false, status: 404 }));
  await expect(getImageUnderstandingStatus(id)).rejects.toThrow(/No result/);
  const result = { source: { postMediaId: id, sourceVersion: 7 }, verified: false, eligibleAsObservation: false, confidenceKind: 'uncalibrated_similarity', processedAt: new Date().toISOString(), candidates: [{ tag: 'beach', confidence: .8, verified: false, eligibleAsObservation: false, basis: 'visual_inference' }] };
  jest.mocked(fetch).mockResolvedValueOnce(reply(result));
  expect((await readImageUnderstanding(status)).tags).toEqual(['beach']);
  jest.mocked(fetch).mockResolvedValueOnce(reply({ ...result, source: { ...result.source, sourceVersion: 8 } }));
  await expect(readImageUnderstanding(status)).rejects.toThrow(/changed/);
  jest.mocked(fetch).mockResolvedValueOnce(reply({ ...result, candidates: [{ ...result.candidates[0], tag: 'face_identity' }] }));
  await expect(readImageUnderstanding(status)).rejects.toThrow(/changed/);
});

