// NOTE: intentionally exhaustive — no native Supabase session is used.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — controlled session identity and token boundary.
jest.mock('../messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: jest.fn(), messagingOwnerToken: jest.fn().mockResolvedValue('token') }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureMessagingOwnerRequest } from '../messagingOwnerRequest.ts';
import { setIntelConsent, readIntelConsent, hasValidConsent, onIntelConsentChange } from '../intelConsent.ts';
const granted = { enabled: true, consentVersion: 'v1', consentedAt: '2026-11-13T12:00:00Z', withdrawnAt: null, currentDisclosureVersion: 'v1' };
const withdrawn = { ...granted, enabled: false, withdrawnAt: '2026-11-13T13:00:00Z' };
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const originalFetch = global.fetch;
let current = true;
beforeEach(() => {
  current = true; jest.clearAllMocks(); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://example.test';
  const id = expect.getState().currentTestName!;
  (captureMessagingOwnerRequest as jest.Mock).mockImplementation(() => ({ ownerId: id, sessionId: 'session', isCurrent: () => current, invalidate: () => {} }));
});
afterEach(() => { global.fetch = originalFetch; });
it('offline withdrawal closes synchronously and a later server-enabled read cannot resume capture', async () => {
  const changed = jest.fn(); const stop = onIntelConsentChange(changed);
  global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  const pending = setIntelConsent(false);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await pending).toBeNull();
  global.fetch = jest.fn().mockResolvedValue(response(granted));
  const read = await readIntelConsent(); expect(read.status).toBe('ok');
  if (read.status === 'ok') expect(hasValidConsent(read.state)).toBe(false);
  stop();
});
it('withdrawal reaches the server even when local persistence fails', async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  global.fetch = jest.fn().mockResolvedValue(response(withdrawn));
  expect((await setIntelConsent(false))?.enabled).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const read = await readIntelConsent();
  if (read.status !== 'ok') throw new Error('expected readable consent');
  expect(hasValidConsent(read.state)).toBe(false);
});
it('successful explicit grant clears the durable hold, but failed clearing does not claim success', async () => {
  global.fetch = jest.fn().mockResolvedValue(response(withdrawn)); await setIntelConsent(false);
  global.fetch = jest.fn().mockResolvedValue(response(granted));
  (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  expect(await setIntelConsent(true, 'v1')).toBeNull();
  expect(hasValidConsent(await setIntelConsent(true, 'v1'))).toBe(true);
  const read = await readIntelConsent();
  if (read.status !== 'ok') throw new Error('expected readable consent');
  expect(hasValidConsent(read.state)).toBe(true);
});
it('a late grant response cannot clear a newer withdrawal or cross account sessions', async () => {
  let resolveGrant!: (value: unknown) => void;
  global.fetch = jest.fn().mockImplementationOnce(() => new Promise(resolve => { resolveGrant = resolve; })).mockResolvedValue(response(withdrawn));
  const oldGrant = setIntelConsent(true, 'v1'); await flush();
  const revoke = setIntelConsent(false); await revoke;
  resolveGrant(response(granted)); expect(await oldGrant).toBeNull();
  global.fetch = jest.fn().mockResolvedValue(response(granted));
  const read = await readIntelConsent();
  if (read.status !== 'ok') throw new Error('expected readable consent');
  expect(hasValidConsent(read.state)).toBe(false);
  let resolveNext!: (value: unknown) => void;
  global.fetch = jest.fn().mockImplementation(() => new Promise(resolve => { resolveNext = resolve; }));
  const next = setIntelConsent(true, 'v1'); await flush(); current = false;
  resolveNext(response(granted)); expect(await next).toBeNull();
});
