import { freshToken } from '../../apiToken.ts';
import { getCaptionAsrStatus, requestCaptionAsr, resolveCaptionSource } from '../captions.ts';

jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));

const source = { assetId: '20000000-0000-4000-a000-000000000001', version: 1, revisionKey: '0'.repeat(64), durationMs: 2000, canEdit: true };
const status = { enabled: false, languages: [], sourceVersion: 1, revisionKey: source.revisionKey, consentEpoch: 'a'.repeat(64), state: 'not_requested', canRevoke: false, current: true };
const savedBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const reply = (overrides: Partial<Response> = {}): Response => ({ ok: true, status: 200, redirected: false, url: '', json: async () => status, ...overrides } as Response);

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  jest.mocked(freshToken).mockResolvedValue('synthetic-caption-token');
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply());
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  jest.useRealTimers();
  if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = savedBase;
});

it('rejects invalid API origins before obtaining a token or issuing a request', async () => {
  for (const base of ['', 'http://api.test', 'http://localhost:3000', 'https://user:pass@api.test', 'https://api.test?next=evil', 'https://api.test#evil', 'https://api.test/nested', 'https://api.test\\evil', '//api.test']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    await expect(getCaptionAsrStatus(source)).rejects.toThrow();
  }
  expect(freshToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('pins bearer requests to the exact HTTPS origin and refuses redirects', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test/';
  await getCaptionAsrStatus(source);
  const [url, options] = jest.mocked(fetch).mock.calls[0];
  expect(url).toBe(`https://api.test/api/media/captions/${source.assetId}/asr`);
  expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-caption-token' } });
  for (const altered of [{ redirected: true }, { url: 'https://foreign.test/stolen' }, { url: 'https://api.test/other' }]) {
    jest.mocked(fetch).mockResolvedValueOnce(reply(altered));
    await expect(getCaptionAsrStatus(source)).rejects.toThrow();
  }
});

it('encodes source references as data without changing the authenticated destination', async () => {
  jest.mocked(fetch).mockResolvedValue(reply({ json: async () => source }));
  const media = 'https://foreign.test/video?x=#fragment';
  await resolveCaptionSource(media);
  expect(jest.mocked(fetch).mock.calls[0][0]).toBe(`https://api.test/api/media/captions/source?source=${encodeURIComponent(media)}`);
});

it('requires a valid epoch in status and sends the captured epoch without refreshing or silently rebasing it', async () => {
  for (const consentEpoch of [undefined, null, 1, '', 'bad', 'a'.repeat(65)]) {
    jest.mocked(fetch).mockResolvedValueOnce(reply({ json: async () => ({ ...status, consentEpoch }) }));
    await expect(getCaptionAsrStatus(source)).rejects.toThrow('Invalid transcription state.');
  }
  const fresh = await getCaptionAsrStatus(source);
  await requestCaptionAsr(source, 'en', true, fresh.consentEpoch);
  const [url, options] = jest.mocked(fetch).mock.calls.at(-1)!;
  expect(url).toBe(`https://api.test/api/media/captions/${source.assetId}/asr`);
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options?.body as string)).toEqual({ version: 1, revisionKey: source.revisionKey, expectedConsentEpoch: fresh.consentEpoch, targetLanguage: 'en', consent: true });
  expect(jest.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('refuses an invalid expected epoch before token lookup or transport', async () => {
  for (const epoch of ['', 'bad', 'a'.repeat(65)]) await expect(requestCaptionAsr(source, 'en', true, epoch)).rejects.toThrow(/consent status/);
  expect(freshToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds token refresh and never sends a token that resolves after the deadline', async () => {
  jest.useFakeTimers();
  let finish!: (token: string) => void;
  jest.mocked(freshToken).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = getCaptionAsrStatus(source);
  const failed = expect(pending).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(10001);
  await failed;
  finish('late-synthetic-token');
  await Promise.resolve();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds an abort-ignoring fetch and aborts its request signal', async () => {
  jest.useFakeTimers();
  jest.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
  const failed = expect(getCaptionAsrStatus(source)).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(10001);
  await failed;
  expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('bounds JSON decoding and respects cancellation before token lookup and while reading', async () => {
  jest.useFakeTimers();
  const before = new AbortController();
  before.abort();
  await expect(getCaptionAsrStatus(source, before.signal)).rejects.toThrow(/cancelled/);
  expect(freshToken).not.toHaveBeenCalled();
  jest.mocked(fetch).mockResolvedValue(reply({ json: () => new Promise(() => {}) }));
  const deadline = expect(getCaptionAsrStatus(source)).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(10001);
  await deadline;
  const controller = new AbortController();
  const cancelled = expect(getCaptionAsrStatus(source, controller.signal)).rejects.toThrow(/cancelled/);
  await Promise.resolve();
  controller.abort();
  await cancelled;
});
