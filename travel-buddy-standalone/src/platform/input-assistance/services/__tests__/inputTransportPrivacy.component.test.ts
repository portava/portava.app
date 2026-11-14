// NOTE: exhaustive — token acquisition and auth subscription are the network boundary;
// the real budget, privacy scope, transport and response parsers remain in use.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: () => mockToken() }));
jest.mock('../../../../services/auth.ts', () => ({ onAuthChange: jest.fn(), getSessionUserId: jest.fn() }));
const mockToken = jest.fn();
const ownerToken = `header.${Buffer.from(JSON.stringify({sub:'privacy-test'})).toString('base64url')}.signature`;
import { requestSuggestions, requestMapSearchPage } from '../inputAssistance.ts';
import { fetchInputPolicies } from '../policyClient.ts';
import { readMemoryContext, writeMemoryContextConsent } from '../memoryContextTransport.ts';
import { readOutcomeConsent, writeOutcomeConsent, postTaskOutcome } from '../outcomeLearningTransport.ts';
import { extractPastedEntities } from '../../paste/pasteExtraction.ts';
import { beginOutcomeAccount, clearOutcomeWithdrawal } from '../outcomeLearning.ts';
import { withInputApiResponse } from '../inputApiRequest.ts';
import { recordSelectionWith } from '../selectBody.ts';
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';

const request = { context: 'caption' as const, fieldId: 'post.caption', text: 'My private draft' };
const memory = { available: true, enabled: true, currentDisclosureVersion: 'v1', facts: [{ city: 'Hanoi', country: null, occurredAt: null }] };
const response = (body: unknown, extra = {}) => ({ ok: true, status: 200, json: jest.fn(async () => body), ...extra });
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
beforeEach(() => {
  jest.useFakeTimers();
  _resetDiscoveryViewerScopeForTests();
  clearOutcomeWithdrawal('privacy-test'); beginOutcomeAccount('privacy-test');
  mockToken.mockReset().mockResolvedValue(ownerToken);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterEach(() => {
  beginOutcomeAccount(null); clearOutcomeWithdrawal('privacy-test');
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers(); global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

test.each([
  ['writing', () => requestSuggestions(request)],
  ['map', () => requestMapSearchPage('Hanoi')],
  ['policies', () => fetchInputPolicies()],
  ['memory', () => readMemoryContext()],
  ['learning', () => readOutcomeConsent()],
  ['paste', () => extractPastedEntities(request)],
])('%s refuses redirected answers before reading their bodies', async (_name, run) => {
  const res = response(memory, { redirected: true, url: 'https://elsewhere.test' });
  const send = jest.fn(async () => res); global.fetch = send as unknown as typeof fetch;
  const result = await run();
  expect(result).not.toMatchObject({ ok: true });
  expect(result).not.toMatchObject({ status: 'ok' });
  expect(send.mock.calls[0]).toEqual([expect.stringMatching(/^https:\/\/api.test\/api\/input-assistance\//), expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' })]);
  expect(res.json).not.toHaveBeenCalled();
});

test.each(['http://api.test', 'https://name:secret@api.test', 'https://api.test?redirect=elsewhere', 'https://api.test/path', 'https://api.test\\elsewhere'])('rejects an unsafe origin: %s', async base => {
  process.env.EXPO_PUBLIC_API_BASE_URL = base; global.fetch = jest.fn();
  expect(await extractPastedEntities(request)).toMatchObject({ ok: false });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('memory consent and learning writes preserve status semantics without following redirects', async () => {
  global.fetch = jest.fn(async () => response(null, { ok: false, status: 409 })) as unknown as typeof fetch;
  expect(await writeMemoryContextConsent(true)).toEqual({ status: 'stale_disclosure' });
  expect(await writeOutcomeConsent(true)).toEqual({ status: 'stale_disclosure' });
  global.fetch = jest.fn(async () => response(null, { url: 'https://unexpected.test' })) as unknown as typeof fetch;
  expect(await writeMemoryContextConsent(false)).toEqual({ status: 'failed' });
  expect(await postTaskOutcome({ outcomeConsentedAt: '2026-10-05T00:00:00.000Z', context: 'city_picker', fieldId: 'trip.destination', task: 'trip_created', ok: true, entities: [] })).toBe(false);
});

test('token stalls time out every private input path without sending a late draft or consent', async () => {
  let release!: (token: string) => void;
  mockToken.mockReturnValue(new Promise(resolve => { release = resolve; }));
  global.fetch = jest.fn();
  const pending = [extractPastedEntities(request), readMemoryContext(), writeMemoryContextConsent(true), readOutcomeConsent(), writeOutcomeConsent(true)];
  await jest.advanceTimersByTimeAsync(5000);
  const results = await Promise.all(pending);
  expect(results).toEqual([expect.objectContaining({ ok: false }), { status: 'unreadable' }, { status: 'failed' }, { status: 'unreadable' }, { status: 'failed' }]);
  release('late'); await Promise.resolve();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('an account switch immediately aborts even a body reader that ignores cancellation', async () => {
  let release!: (value: unknown) => void;
  const json = jest.fn(() => new Promise(resolve => { release = resolve; }));
  global.fetch = jest.fn(async () => response(null, { json })) as unknown as typeof fetch;
  const pending = readMemoryContext();
  await jest.advanceTimersByTimeAsync(0);
  expect(json).toHaveBeenCalled();
  setDiscoveryViewerFromSession('next-person');
  expect(await pending).toEqual({ status: 'unreadable' });
  release(memory); await Promise.resolve();
});

test('one absolute deadline includes authentication, headers and JSON decoding', async () => {
  mockToken.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('token'), 2000)));
  global.fetch = jest.fn(async () => response(null, { json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  const pending = readMemoryContext();
  await jest.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: 'unreadable' });
});

test('caller cancellation releases pending paste work and a valid read still succeeds', async () => {
  global.fetch = jest.fn(async () => response(memory)) as unknown as typeof fetch;
  expect(await readMemoryContext()).toMatchObject({ status: 'ok', view: { facts: memory.facts } });
  const controller = new AbortController(); controller.abort(); global.fetch = jest.fn();
  expect(await extractPastedEntities(request, controller.signal)).toMatchObject({ ok: false });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('telemetry-style consumers and selection records share the same bounded transport', async () => {
  global.fetch = jest.fn(async () => response({ ok: true, recorded: true }, { redirected: true })) as unknown as typeof fetch;
  await expect(withInputApiResponse('/api/input-assistance/telemetry', { method: 'POST' }, async res => res.ok)).rejects.toThrow('redirected');
  expect(await recordSelectionWith({ apiBase: () => 'https://api.test', getToken: async () => 'token', fetchImpl: global.fetch }, { context: 'city_picker', fieldId: 'trip.destination', entityType: 'city', entityId: 'hanoi' })).toMatchObject({ recorded: false });
});
