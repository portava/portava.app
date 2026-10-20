import { setResurfacingControl, clearResurfacingControl } from '../privacyControlsApi.ts';
import { freshToken } from '../../../services/apiToken.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';

jest.mock('../../../lib/supabase', () => ({ ...jest.requireActual('../../../lib/supabase'), isSupabaseConfigured: true }));
jest.mock('../../../services/apiToken', () => ({ ...jest.requireActual('../../../services/apiToken'), freshToken: jest.fn() }));
jest.mock('../../../services/memories', () => ({ ...jest.requireActual('../../../services/memories'), newMemoryOperationId: jest.fn(() => `policy-${Math.random()}`) }));

const subject = '33333333-3333-4333-8333-333333333333';
const token = (owner: string) => `header.${btoa(JSON.stringify({ sub: owner }))}.signature`;
const response = (status = 200) => ({ ok: status < 400, status, json: async () => status < 400 ? { cleared: true } : { error: 'degraded_unavailable' } });
let fetchMock: jest.Mock;
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
afterAll(async () => { await jest.requireActual('../../../lib/supabase').supabase?.auth.stopAutoRefresh(); });
beforeEach(() => {
  setDiscoveryViewerFromSession(null);
  setDiscoveryViewerFromSession('owner');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  (freshToken as jest.Mock).mockResolvedValue(token('owner'));
  fetchMock = jest.fn().mockResolvedValue(response());
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

for (const method of ['set', 'clear']) test(`${method} reuses its operation ID after unknown commit, then retires it on success`, async () => {
  const write = () => method === 'set' ? setResurfacingControl('DO_NOT_RESURFACE', subject)
    : clearResurfacingControl('KEEP_PRIVATE_FOREVER', subject, { confirm: true });
  fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
  expect((await write()).ok).toBe(false);
  expect((await write()).ok).toBe(true);
  expect((await write()).ok).toBe(true);
  const keys = fetchMock.mock.calls.map((entry) => entry[1].headers['Idempotency-Key']);
  expect(typeof keys[0]).toBe('string');
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  if (method === 'clear') expect(JSON.parse(fetchMock.mock.calls[1][1].body).confirm).toBe(true);
});

test('an unresolved set cannot be overtaken by a clear', async () => {
  fetchMock.mockResolvedValueOnce(response(503));
  await setResurfacingControl('DO_NOT_RESURFACE', subject);
  expect((await clearResurfacingControl('DO_NOT_RESURFACE', subject)).ok).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await setResurfacingControl('DO_NOT_RESURFACE', subject);
  await clearResurfacingControl('DO_NOT_RESURFACE', subject);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('an account change during token lookup never sends the previous owner intent', async () => {
  let finish!: (value: string) => void;
  (freshToken as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = setResurfacingControl('DO_NOT_RESURFACE', subject);
  setDiscoveryViewerFromSession('other');
  finish(token('other'));
  expect((await pending).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an unknown commit is recoverable after same-account relogin, never reused by another account', async () => {
  const ownSubject = '44444444-4444-4444-8444-444444444444';
  fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
  const first = await setResurfacingControl('DO_NOT_RESURFACE', ownSubject);
  setDiscoveryViewerFromSession('other');
  (freshToken as jest.Mock).mockResolvedValue(token('other'));
  await setResurfacingControl('DO_NOT_RESURFACE', ownSubject);
  setDiscoveryViewerFromSession(null);
  setDiscoveryViewerFromSession('owner');
  (freshToken as jest.Mock).mockResolvedValue(token('owner'));
  const retry = await setResurfacingControl('DO_NOT_RESURFACE', ownSubject);
  expect(retry.operationId).toBe(first.operationId);
  const keys = fetchMock.mock.calls.map((entry) => entry[1].headers['Idempotency-Key']);
  expect(keys[1]).not.toBe(keys[0]);
  expect(keys[2]).toBe(keys[0]);
});
