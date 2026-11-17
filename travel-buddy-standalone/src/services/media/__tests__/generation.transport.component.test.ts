import { setDiscoveryViewerFromSession } from '../../discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent } from '../../__tests__/observedOwnerSessionFixture.ts';
// NOTE: complete auth observer plus a passive realtime channel; no native network client.
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  const channel = { on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis() };
  return { isSupabaseConfigured: true, supabase: { channel: jest.fn(() => channel), removeChannel: jest.fn(async () => {}), realtime: { setAuth: jest.fn(async () => {}) }, auth: {
    listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; },
  } } };
});
jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));
import { freshToken } from '../../apiToken.ts';
import { supabase } from '../../../lib/supabase.ts';
import { createGenerationDraft, getGenerationDrafts, previewGenerationDraft, subscribeGenerationDrafts } from '../generation.ts';
const owner = '10000000-0000-4000-a000-000000000001', id = '20000000-0000-4000-a000-000000000001';
const draft = { id, requestId: id, kind: 'image', model: 'soul', state: 'ready', estimateUsd: 0.0057, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), aiGenerated: true };
const status = { enabled: true, image: true, video: true, policyVersion: 'v1', disclosure: 'External AI generation', models: { image: { label: 'Image', estimateUsd: 0.0057 }, video: { label: 'Video', estimateUsd: 1.3235 } }, jobs: [draft] };
const reply = (body: unknown, extra: Partial<Response> = {}) => ({ ok: true, status: 200, redirected: false, url: '', json: async () => body, ...extra } as Response);
const originalApi = process.env.EXPO_PUBLIC_API_BASE_URL, originalStorage = process.env.EXPO_PUBLIC_SUPABASE_URL;
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://storage.test';
  setDiscoveryViewerFromSession(owner); seedObservedOwnerSession(owner, 'generation-session');
  jest.mocked(freshToken).mockResolvedValue(observedOwnerAccessToken(owner, 'generation-session'));
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(status));
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers();
  if (originalApi === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = originalApi;
  if (originalStorage === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL; else process.env.EXPO_PUBLIC_SUPABASE_URL = originalStorage;
});
it('requires a secure API, refuses redirects and malformed drafts', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; await expect(getGenerationDrafts()).rejects.toThrow(/secure/); expect(fetch).not.toHaveBeenCalled();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  jest.mocked(fetch).mockResolvedValueOnce(reply(status, { redirected: true })); await expect(getGenerationDrafts()).rejects.toThrow(/changed/);
  jest.mocked(fetch).mockResolvedValueOnce(reply({ ...status, jobs: [{ ...draft, aiGenerated: false }] })); await expect(getGenerationDrafts()).rejects.toThrow(/unavailable/);
});
it('preserves the caller request id on retries and rejects another request response', async () => {
  const body = { requestId: id, kind: 'image' as const, prompt: 'A calm beach', aspectRatio: '16:9' as const, consentVersion: 'v1' };
  jest.mocked(fetch).mockResolvedValueOnce(reply(draft)).mockResolvedValueOnce(reply(draft));
  await createGenerationDraft(body); await createGenerationDraft(body);
  expect(jest.mocked(fetch).mock.calls[0][1]?.body).toEqual(jest.mocked(fetch).mock.calls[1][1]?.body);
  jest.mocked(fetch).mockResolvedValueOnce(reply({ ...draft, requestId: owner })); await expect(createGenerationDraft(body)).rejects.toThrow(/confirm/);
});
it('allows only private storage previews', async () => {
  for (const url of ['https://evil.test/file', 'https://storage.test/storage/v1/object/public/generated-media-private/file']) {
    jest.mocked(fetch).mockResolvedValueOnce(reply({ ...draft, url })); await expect(previewGenerationDraft(id)).rejects.toThrow(/connection/);
  }
  const url = `https://storage.test/storage/v1/object/sign/generated-media-private/${owner}/${id}/output.webp?token=test`;
  jest.mocked(fetch).mockResolvedValueOnce(reply({ ...draft, url })); expect((await previewGenerationDraft(id)).url).toBe(url);
});
it('ignores responses from a replaced session and bounds response-body waits', async () => {
  jest.useFakeTimers(); let finish!: (value: unknown) => void;
  jest.mocked(fetch).mockResolvedValueOnce(reply(null, { json: () => new Promise(resolve => { finish = resolve; }) }));
  const pending = expect(getGenerationDrafts()).rejects.toThrow(/session changed/);
  await jest.advanceTimersByTimeAsync(0); emitObservedAuthEvent('SIGNED_OUT', null); finish(status); await pending;
  expect(jest.getTimerCount()).toBe(0);
});
it('subscribes to only the owner channel and never polls while idle', async () => {
  jest.useFakeTimers(); const changed = jest.fn(), unavailable = jest.fn();
  const close = subscribeGenerationDrafts(changed, unavailable); await jest.advanceTimersByTimeAsync(0);
  expect(supabase.channel).toHaveBeenCalledWith(`media-generation:${owner}`, { config: { private: true } });
  const channel = jest.mocked(supabase.channel).mock.results[0].value;
  const callback = jest.mocked(channel.on).mock.calls[0][2] as (event: unknown) => void;
  callback({ payload: { id } }); expect(changed).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60000); expect(fetch).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledTimes(1);
  close(); callback({ payload: { id } }); expect(changed).toHaveBeenCalledTimes(1); expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
});
