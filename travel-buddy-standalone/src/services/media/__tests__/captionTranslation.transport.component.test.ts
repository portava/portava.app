import { freshToken } from '../../apiToken.ts';
import { getCaptionTranslationStatus, requestCaptionTranslation, revokeCaptionTranslation, readCaptionTranslationDraft, publishCaptionTranslation } from '../captionTranslation.ts';

jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));

const source = { assetId: '20000000-0000-4000-a000-000000000001', version: 2, revisionKey: 'a'.repeat(64), durationMs: 3000, canEdit: true };
const status = { enabled: true, allowedPairs: [{ source: 'en', target: 'fr' }], sourceVersion: 2, revisionKey: source.revisionKey, consentEpoch: 7, state: 'not_requested', canRevoke: false, current: true, cleanupPending: false };
const draft = { draftId: 'd'.repeat(64), version: 2, revisionKey: source.revisionKey, vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nBonjour', language: 'fr', sourceLanguage: 'en', aiLabel: 'AI translation · needs creator review' as const, modelVersion: 'synthetic-fixture' };
const published = { assetId: source.assetId, version: 2, revisionKey: 'b'.repeat(64), language: 'fr', sourceKind: 'translation', aiLabel: 'AI translation · creator reviewed', availableLanguages: ['en', 'fr'], cleanupPending: false };
const savedBase = process.env.EXPO_PUBLIC_API_BASE_URL;
function response(value: unknown, overrides: Partial<Response> = {}): Response {
  return { ok: true, status: 200, redirected: false, url: '', headers: { get: () => null } as unknown as Headers, text: async () => JSON.stringify(value), ...overrides } as Response;
}
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  jest.mocked(freshToken).mockResolvedValue('synthetic-translation-token');
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(status));
});
afterEach(() => {
  jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers();
  if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = savedBase;
});

it('pins creator bearer traffic to HTTPS and rejects invalid origins, viewers and redirects before parsing text', async () => {
  for (const base of ['', 'http://api.test', 'https://user@api.test', 'https://api.test/nested', 'https://api.test?next=evil', 'https://api.test#fragment', 'https://api.test\\evil']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    await expect(getCaptionTranslationStatus(source)).rejects.toThrow();
  }
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  await expect(getCaptionTranslationStatus({ ...source, canEdit: false })).rejects.toThrow();
  expect(freshToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await getCaptionTranslationStatus(source);
  expect(jest.mocked(fetch).mock.calls[0]).toEqual([`https://api.test/api/media/caption-translations/${source.assetId}`, expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-translation-token', 'Content-Type': 'application/json' } })]);
  for (const changed of [{ redirected: true }, { url: 'https://foreign.test/stolen' }, { url: 'https://api.test/other' }]) {
    jest.mocked(fetch).mockResolvedValueOnce(response(status, changed));
    await expect(getCaptionTranslationStatus(source)).rejects.toThrow(/redirected/);
  }
});

it('requires a numeric translation epoch, not ASR consent, and never silently refreshes a captured request', async () => {
  for (const consentEpoch of [undefined, 'a'.repeat(64), -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    jest.mocked(fetch).mockResolvedValueOnce(response({ ...status, consentEpoch }));
    await expect(getCaptionTranslationStatus(source)).rejects.toThrow(/Invalid/);
  }
  jest.mocked(fetch).mockResolvedValueOnce(response({ ...status, consentEpoch: 0 }));
  expect((await getCaptionTranslationStatus(source)).consentEpoch).toBe(0);
  jest.mocked(fetch).mockResolvedValueOnce(response({ ...status, jobId: '30000000-0000-4000-a000-000000000001', state: 'pending' }));
  await requestCaptionTranslation(source, 'en', 'fr', true, status.consentEpoch);
  const [url, options] = jest.mocked(fetch).mock.calls.at(-1)!;
  expect(url).toBe(`https://api.test/api/media/caption-translations/${source.assetId}`);
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options?.body as string)).toEqual({ version: 2, revisionKey: source.revisionKey, sourceLanguage: 'en', targetLanguage: 'fr', consent: true, expectedConsentEpoch: 7 });
  jest.mocked(fetch).mockResolvedValueOnce(response({}, { ok: false, status: 409 }));
  const before = jest.mocked(fetch).mock.calls.length;
  await expect(requestCaptionTranslation(source, 'en', 'fr', true, 7)).rejects.toThrow(/Close and reopen/);
  expect(fetch).toHaveBeenCalledTimes(before + 1);
});

it('explicit translation permission is mandatory before any job request', async () => {
  let queued = 0;
  jest.mocked(fetch).mockImplementation(async () => { queued += 1; return response({ ...status, jobId: '30000000-0000-4000-a000-000000000001' }); });
  const refused = await requestCaptionTranslation(source, 'en', 'fr', false, 7).then(() => null, (error: unknown) => error);
  expect(queued).toBe(0);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toMatch(/permission/);
  await expect(requestCaptionTranslation(source, 'en', 'en', true, 7)).rejects.toThrow();
  await expect(requestCaptionTranslation(source, '../bad', 'fr', true, 7)).rejects.toThrow();
  await expect(requestCaptionTranslation(source, 'en', 'fr', true, -1)).rejects.toThrow();
  expect(queued).toBe(0);
  expect(freshToken).not.toHaveBeenCalled();
});

it('reads only generation/revision-bound AI translation drafts and refuses substituted labels or source tracks', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({ draft: null }));
  expect(await readCaptionTranslationDraft(source)).toBeNull();
  jest.mocked(fetch).mockResolvedValueOnce(response({ draft }));
  expect(await readCaptionTranslationDraft(source)).toEqual(draft);
  expect(jest.mocked(fetch).mock.calls.at(-1)![0]).toContain('/draft?version=2');
  for (const changed of [{ version: 3 }, { revisionKey: 'b'.repeat(64) }, { aiLabel: 'AI transcription · needs creator review' }, { language: 'en' }, { vtt: 'x'.repeat(262145) }]) {
    jest.mocked(fetch).mockResolvedValueOnce(response({ draft: { ...draft, ...changed } }));
    await expect(readCaptionTranslationDraft(source)).rejects.toThrow(/stale translation draft/);
  }
});

it('publishes reviewed edited text only via the translation route and preserves the source request identity', async () => {
  await expect(publishCaptionTranslation(source, draft, draft.vtt, false)).rejects.toThrow(/Review/);
  expect(fetch).not.toHaveBeenCalled();
  jest.mocked(fetch).mockResolvedValueOnce(response(published));
  const edited = draft.vtt.replace('Bonjour', 'Reviewed translation');
  expect(await publishCaptionTranslation(source, draft, edited, true)).toEqual(published);
  const [url, options] = jest.mocked(fetch).mock.calls[0];
  expect(url).toBe(`https://api.test/api/media/caption-translations/${source.assetId}/draft/publish`);
  expect(JSON.parse(options?.body as string)).toEqual({ version: 2, revisionKey: source.revisionKey, draftId: draft.draftId, reviewed: true, vtt: edited });
  expect(draft.vtt).toContain('Bonjour');
  jest.mocked(fetch).mockResolvedValueOnce(response({ ...published, assetId: 'foreign' }));
  await expect(publishCaptionTranslation(source, draft, edited, true)).rejects.toThrow(/could not be confirmed/);
});

it('withdraws with no body or inference and preserves honest cleanup debt', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({ revoked: true, consentEpoch: 8, cleanupPending: true }));
  expect(await revokeCaptionTranslation(source)).toEqual({ revoked: true, consentEpoch: 8, cleanupPending: true });
  expect(jest.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  expect(jest.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
  jest.mocked(fetch).mockResolvedValueOnce(response({ revoked: false, consentEpoch: 8, cleanupPending: false }));
  await expect(revokeCaptionTranslation(source)).rejects.toThrow(/could not be confirmed/);
});

it('bounds token lookup and ignores late token completion without sending private caption text', async () => {
  jest.useFakeTimers();
  let finish!: (token: string) => void;
  jest.mocked(freshToken).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const failed = expect(publishCaptionTranslation(source, draft, draft.vtt, true)).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(10001); await failed;
  finish('late-token'); await Promise.resolve(); await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels an abort-ignoring response and rejects oversized or malformed status bodies', async () => {
  const abort = new AbortController();
  jest.mocked(fetch).mockResolvedValueOnce(response(status, { text: () => new Promise(() => {}) }));
  const failed = expect(getCaptionTranslationStatus(source, abort.signal)).rejects.toThrow(/cancelled/);
  await Promise.resolve(); abort.abort(); await failed;
  jest.mocked(fetch).mockResolvedValueOnce(response(status, { headers: { get: () => '2000001' } as unknown as Headers }));
  await expect(getCaptionTranslationStatus(source)).rejects.toThrow(/too large/);
  jest.mocked(fetch).mockResolvedValueOnce(response({ ...status, allowedPairs: [{ source: 'en', target: 'en' }] }));
  await expect(getCaptionTranslationStatus(source)).rejects.toThrow(/Invalid/);
});
