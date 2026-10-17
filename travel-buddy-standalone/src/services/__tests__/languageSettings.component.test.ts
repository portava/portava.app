import { waitFor } from '@testing-library/react-native';
import { freshToken } from '../apiToken.ts';
import { supabase } from '../../lib/supabase.ts';
import { getMyLanguageSettings, updateMyLanguageSettings } from '../messaging.ts';

jest.mock('../apiToken.ts', () => ({ ...jest.requireActual('../apiToken.ts'), freshToken: jest.fn() }));
jest.mock('../../lib/supabase.ts', () => ({ ...jest.requireActual('../../lib/supabase.ts'), isSupabaseConfigured: true,
  supabase: { auth: { getSession: jest.fn() } },
}));

const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const mockFetch = jest.fn();
const response = (language: string) => ({ ok: true, status: 200, json: async () => ({ preferred_language: language }) });
const scope = { userId: 'alice', isCurrent: () => true };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://app.example';
  global.fetch = mockFetch;
  jest.mocked(freshToken).mockResolvedValue('alice-token');
  jest.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { user: { id: 'alice' }, access_token: 'alice-token' } } } as never);
  mockFetch.mockResolvedValue(response('fr'));
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('reuses the existing language endpoint and profile field with the captured viewer token', async () => {
  expect((await getMyLanguageSettings(scope)).data?.preferred_language).toBe('fr');
  expect((await updateMyLanguageSettings({ preferred_language: 'fr' }, scope)).ok).toBe(true);
  expect(mockFetch).toHaveBeenLastCalledWith('https://app.example/api/me/language-settings', expect.objectContaining({
    method: 'PATCH', headers: expect.objectContaining({ Authorization: 'Bearer alice-token' }), body: JSON.stringify({ preferred_language: 'fr' }),
  }));
});

it('rejects stale callbacks before token acquisition and another viewer after token acquisition', async () => {
  expect((await updateMyLanguageSettings({ preferred_language: 'fr' }, { ...scope, isCurrent: () => false })).ok).toBe(false);
  expect(freshToken).not.toHaveBeenCalled();
  jest.mocked(freshToken).mockResolvedValue('bob-token');
  jest.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { user: { id: 'bob' }, access_token: 'bob-token' } } } as never);
  expect((await updateMyLanguageSettings({ preferred_language: 'fr' }, scope)).ok).toBe(false);
  expect((await getMyLanguageSettings(scope)).ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('rejects a pre-switch token even if the session now belongs to the intended account', async () => {
  jest.mocked(freshToken).mockResolvedValue('bob-token');
  expect((await updateMyLanguageSettings({ preferred_language: 'fr' }, scope)).ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('fences a same-account logout/login during a deferred token request', async () => {
  let current = true;
  let finish!: (token: string) => void;
  jest.mocked(freshToken).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const saving = updateMyLanguageSettings({ preferred_language: 'fr' }, { ...scope, isCurrent: () => current });
  await waitFor(() => expect(finish).toBeDefined());
  current = false;
  finish('alice-token');
  expect((await saving).ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('serializes same-account saves and a new login read behind an already transmitted request', async () => {
  let current = true;
  let finish!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = updateMyLanguageSettings({ preferred_language: 'es' }, { ...scope, isCurrent: () => current });
  await waitFor(() => expect(finish).toBeDefined());
  const stale = updateMyLanguageSettings({ preferred_language: 'de' }, { ...scope, isCurrent: () => current });
  current = false;
  const newer = updateMyLanguageSettings({ preferred_language: 'fr' }, scope);
  const reading = getMyLanguageSettings(scope);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  finish(response('es'));
  expect((await first).ok).toBe(false);
  expect((await stale).ok).toBe(false);
  expect((await newer).ok).toBe(true);
  expect((await reading).data?.preferred_language).toBe('fr');
  expect(mockFetch).toHaveBeenCalledTimes(3);
  expect(mockFetch.mock.calls.map(([, init]) => init.body ?? 'GET')).toEqual([JSON.stringify({ preferred_language: 'es' }), JSON.stringify({ preferred_language: 'fr' }), 'GET']);
});

it('failure does not block a newer selection and never changes messaging automatic translation', async () => {
  mockFetch.mockRejectedValueOnce(new Error('Network request failed'));
  expect((await updateMyLanguageSettings({ preferred_language: null }, scope)).ok).toBe(false);
  expect((await updateMyLanguageSettings({ preferred_language: 'fr' }, scope)).ok).toBe(true);
  expect(mockFetch.mock.calls.every(([, init]) => !init.body.includes('auto_translate_messages'))).toBe(true);
});
