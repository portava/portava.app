import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { LanguagePreferenceProvider, useLanguagePreference } from '../LanguagePreferenceContext.tsx';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readAutomaticDubbingPreference, writeAutomaticDubbingPreference } from '../../services/languagePreferences.ts';

let mockUser: string | null = 'alice';
const mockRead = jest.fn();
const mockUpdate = jest.fn();
let mockAuthListener: (event: AuthChangeEvent, session: Session | null) => void;
const mockGetSession = jest.fn();
const mockUnsubscribe = jest.fn();
const mockSubscribe = jest.fn();
let mockConfigured = true;
jest.mock('../SessionContext', () => ({ ...jest.requireActual('../SessionContext'), useSession: () => ({ userId: mockUser, configured: mockConfigured, isAuthed: Boolean(mockUser) }) }));
jest.mock('../../lib/supabase.ts', () => ({ ...jest.requireActual('../../lib/supabase.ts'), supabase: { auth: {
  getSession: () => mockGetSession(),
  onAuthStateChange: (listener: typeof mockAuthListener) => { mockSubscribe(listener); mockAuthListener = listener; return { data: { subscription: { unsubscribe: mockUnsubscribe } } }; },
} } }));
jest.mock('../../services/messaging', () => ({ ...jest.requireActual('../../services/messaging'),
  getMyLanguageSettings: (...args: unknown[]) => mockRead(...args),
  updateMyLanguageSettings: (...args: unknown[]) => mockUpdate(...args),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => <LanguagePreferenceProvider>{children}</LanguagePreferenceProvider>;
const settings = (language: string) => ({ ok: true, data: { preferred_language: language } });

function authSession(owner = 'alice', sessionId: unknown = 'session-a', version = 'initial'): Session {
  return {
    access_token: `e30.${Buffer.from(JSON.stringify({ sub: owner, session_id: sessionId, version })).toString('base64url')}.synthetic`,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T00:00:00Z' },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(finish => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(async () => {
  mockUser = 'alice';
  mockConfigured = true;
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockRead.mockReset();
  mockUpdate.mockReset();
  mockGetSession.mockReset().mockImplementation(async () => ({ data: { session: mockUser ? authSession(mockUser) : null }, error: null }));
  mockSubscribe.mockReset();
});

afterEach(async () => { await cleanup(); });

it('reloads the preference for a different authenticated viewer without carrying the previous language', async () => {
  mockRead.mockResolvedValueOnce(settings('es')).mockResolvedValueOnce(settings('de'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  mockUser = 'bob';
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  expect(mockRead).toHaveBeenCalledTimes(2);
});

it('discards a late preference read after logout', async () => {
  let finish!: (value: ReturnType<typeof settings>) => void;
  mockRead.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  mockUser = null;
  await hook.rerender({});
  await act(async () => { finish(settings('es')); });
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(hook.result.current.loading).toBe(false);
});

it('does not restore another account preference when an earlier save fails', async () => {
  mockRead.mockResolvedValueOnce(settings('es')).mockResolvedValueOnce(settings('de'));
  let finish!: (value: { ok: boolean }) => void;
  mockUpdate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  let saving!: Promise<unknown>;
  await act(() => { saving = hook.result.current.updateLanguage('fr'); });
  mockUser = 'bob';
  await hook.rerender({});
  await act(async () => { finish({ ok: false }); await saving; });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
});

it('does not roll back a newer successful selection when an older save fails', async () => {
  mockRead.mockResolvedValue(settings('es'));
  let finish!: (value: { ok: boolean }) => void;
  mockUpdate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: true });
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  let saving!: Promise<unknown>;
  await act(() => { saving = hook.result.current.updateLanguage('fr'); });
  await act(async () => { await hook.result.current.updateLanguage('de'); });
  await act(async () => { finish({ ok: false }); await saving; });
  expect(hook.result.current.preferredLanguage).toBe('de');
});

it('persists explicit automatic audio across remount and logout/login without changing the shared language', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  let hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  expect(hook.result.current.automaticDubbingPreference).toEqual({ userId: 'alice', enabled: false });
  await act(async () => { expect(await hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true })).toEqual({ ok: true }); });
  expect(mockUpdate).not.toHaveBeenCalled();
  await hook.unmount();
  hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(true));
  mockUser = null;
  await hook.rerender({});
  expect(hook.result.current.automaticDubbingPreference).toBeUndefined();
  expect(hook.result.current.preferredLanguage).toBeNull();
  mockUser = 'alice';
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(true));
  expect(hook.result.current.preferredLanguage).toBe('fr');
});

it('keeps accounts separate and refuses callbacks captured by a previous account', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  await writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => true);
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(true));
  const previous = hook.result.current;
  mockUser = 'bob';
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.automaticDubbingPreference).toEqual({ userId: 'bob', enabled: false }));
  await act(async () => {
    expect((await previous.updateAutomaticDubbing({ userId: 'alice', enabled: false })).ok).toBe(false);
    expect((await previous.updateLanguage('de')).ok).toBe(false);
    expect((await hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false);
  });
  expect(await readAutomaticDubbingPreference('alice')).toBe(true);
  expect(await readAutomaticDubbingPreference('bob')).toBe(false);
  expect(mockUpdate).not.toHaveBeenCalled();
});

it('fences old reads, saves and callbacks across batched logout/login to the same account', async () => {
  let finishRead!: (value: ReturnType<typeof settings>) => void;
  let finishSave!: (value: { ok: boolean }) => void;
  mockRead.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; })).mockResolvedValue(settings('de'));
  mockUpdate.mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  const previous = hook.result.current;
  let saving!: ReturnType<typeof previous.updateLanguage>;
  await act(() => { saving = previous.updateLanguage('es'); });
  await act(async () => {
    mockAuthListener('SIGNED_OUT', null);
    mockAuthListener('SIGNED_IN', authSession('alice', 'session-b'));
  });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  await act(async () => { finishRead(settings('fr')); finishSave({ ok: true }); expect((await saving).ok).toBe(false); });
  expect(hook.result.current.preferredLanguage).toBe('de');
  await act(async () => { expect((await previous.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false); });
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
});

it('does not let a delayed storage read override an explicit preference or another account', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  let finish!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  let saving!: ReturnType<typeof hook.result.current.updateAutomaticDubbing>;
  await act(() => { saving = hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: false }); });
  await act(async () => { finish(JSON.stringify({ version: 1, userId: 'alice', enabled: true })); await saving; });
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
  let finishOther!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finishOther = resolve; }));
  mockUser = 'bob';
  await hook.rerender({});
  mockUser = 'alice';
  await hook.rerender({});
  await act(async () => { finishOther(JSON.stringify({ version: 1, userId: 'bob', enabled: true })); });
  await waitFor(() => expect(hook.result.current.automaticDubbingPreference).toEqual({ userId: 'alice', enabled: false }));
});

it('rolls back an in-flight storage opt-in before the same-account new session can read it', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  const originalSet = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
  let finish!: () => void;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce((key, value) => new Promise(resolve => {
    finish = () => { void originalSet(key, value).then(() => resolve()); };
  }));
  let saving!: ReturnType<typeof hook.result.current.updateAutomaticDubbing>;
  await act(() => { saving = hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true }); });
  await waitFor(() => expect(finish).toBeDefined());
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
  await act(async () => { mockAuthListener('SIGNED_OUT', null); mockAuthListener('SIGNED_IN', authSession('alice', 'session-b')); });
  await act(async () => { finish(); expect((await saving).ok).toBe(false); });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
});

it('fails closed on storage failure and ignores an ordinary same-user token refresh', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await act(async () => { expect((await hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false); });
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
  const epoch = hook.result.current.preferenceSession;
  await act(async () => { mockAuthListener('TOKEN_REFRESHED', authSession('alice', 'session-a', 'rotated')); });
  expect(hook.result.current.preferenceSession).toBe(epoch);
  expect(mockRead).toHaveBeenCalledTimes(1);
});

it('does not read or write preferences while unauthenticated or unconfigured', async () => {
  mockConfigured = false;
  const hook = await renderHook(useLanguagePreference, { wrapper });
  expect(mockRead).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  await act(async () => { expect((await hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false); });
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('waits for an authoritative initial session and refuses callbacks captured before identity initialization', async () => {
  const initial = deferred<{ data: { session: Session }; error: null }>();
  mockGetSession.mockReturnValue(initial.promise);
  mockRead.mockResolvedValue(settings('es'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  expect(mockGetSession).toHaveBeenCalledTimes(1);
  expect(mockRead).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  expect(hook.result.current.loading).toBe(true);
  const unknown = hook.result.current;
  await act(async () => {
    expect((await unknown.updateLanguage('fr')).ok).toBe(false);
    expect((await unknown.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false);
  });
  await act(async () => { initial.resolve({ data: { session: authSession() }, error: null }); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  await act(async () => { expect((await unknown.updateLanguage('de')).ok).toBe(false); });
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it.each(['rejected', 'SDK error', 'null', 'malformed token', 'mismatched subject', 'missing session', 'blank session'] as const)(
  'withholds preference reads and writes for %s initial identity', async failure => {
    let initial: Session | null = authSession();
    if (failure === 'malformed token') initial.access_token = 'not-a-session-token';
    if (failure === 'mismatched subject') initial.user.id = 'other-owner';
    if (failure === 'null') initial = null;
    if (failure === 'missing session') initial = authSession('alice', null);
    if (failure === 'blank session') initial = authSession('alice', '   ');
    if (failure === 'rejected') mockGetSession.mockRejectedValue(new Error('Synthetic auth unavailable'));
    else mockGetSession.mockResolvedValue({ data: { session: initial }, error: failure === 'SDK error' ? new Error('Synthetic SDK error') : null });
    mockRead.mockResolvedValue(settings('es'));
    const hook = await renderHook(useLanguagePreference, { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.preferredLanguage).toBeNull();
    expect(hook.result.current.automaticDubbingPreference).toBeUndefined();
    expect(hook.result.current.automaticDubbingLoading).toBe(false);
    await act(async () => {
      expect((await hook.result.current.updateLanguage('fr')).ok).toBe(false);
      expect((await hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false);
    });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  },
);

it('invalidates a pending same-owner read and old save callbacks synchronously on session replacement', async () => {
  const previousRead = deferred<ReturnType<typeof settings>>();
  const currentRead = deferred<ReturnType<typeof settings>>();
  mockRead.mockReturnValueOnce(previousRead.promise).mockReturnValueOnce(currentRead.promise);
  mockUpdate.mockResolvedValue({ ok: true });
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1));
  const previous = hook.result.current;
  const previousScope = mockRead.mock.calls[0][0];
  await act(async () => {
    mockAuthListener('SIGNED_IN', authSession('alice', 'replacement'));
    expect(previousScope.isCurrent()).toBe(false);
    expect((await previous.updateLanguage('fr')).ok).toBe(false);
    expect((await previous.updateAutomaticDubbing({ userId: 'alice', enabled: true })).ok).toBe(false);
    previousRead.resolve(settings('es'));
  });
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(hook.result.current.preferenceSession).toBeGreaterThan(previous.preferenceSession);
  await act(async () => { currentRead.resolve(settings('de')); });
  expect(hook.result.current.preferredLanguage).toBe('de');
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it.each(['TOKEN_REFRESHED', 'SIGNED_IN'] as const)('retains the pending read, scope and callbacks on healthy same-session %s', async event => {
  const pending = deferred<ReturnType<typeof settings>>();
  mockRead.mockReturnValue(pending.promise);
  mockUpdate.mockResolvedValue({ ok: true });
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1));
  const previous = hook.result.current;
  await act(async () => {
    mockAuthListener(event, authSession('alice', 'session-a', 'rotated-token'));
    mockAuthListener(event, authSession('alice', 'session-a', 'rotated-again'));
    pending.resolve(settings('es'));
  });
  expect(hook.result.current.preferredLanguage).toBe('es');
  expect(hook.result.current.preferenceSession).toBe(previous.preferenceSession);
  expect(mockRead.mock.calls[0][0].isCurrent()).toBe(true);
  expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => { expect((await previous.updateLanguage('fr')).ok).toBe(true); });
  expect(hook.result.current.preferredLanguage).toBe('fr');
});

it.each([true, false])('does not adopt or roll back a late old-session save with ok=%s', async saved => {
  const pending = deferred<{ ok: boolean }>();
  mockRead.mockResolvedValueOnce(settings('es')).mockResolvedValueOnce(settings('de'));
  mockUpdate.mockReturnValue(pending.promise);
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  let saving!: ReturnType<typeof hook.result.current.updateLanguage>;
  await act(() => { saving = hook.result.current.updateLanguage('fr'); });
  await act(async () => { mockAuthListener('SIGNED_IN', authSession('alice', 'replacement')); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  await act(async () => { pending.resolve({ ok: saved }); expect((await saving).ok).toBe(false); });
  expect(hook.result.current.preferredLanguage).toBe('de');
});

it('does not let late bootstrap or INITIAL_SESSION resurrect a superseded same-owner identity', async () => {
  const initial = deferred<{ data: { session: Session }; error: null }>();
  mockGetSession.mockReturnValue(initial.promise);
  mockRead.mockResolvedValue(settings('de'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  expect(mockGetSession).toHaveBeenCalledTimes(1);
  expect(mockRead).not.toHaveBeenCalled();
  await act(async () => { mockAuthListener('SIGNED_IN', authSession('alice', 'replacement')); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  const current = hook.result.current;
  await act(async () => {
    initial.resolve({ data: { session: authSession() }, error: null });
    mockAuthListener('INITIAL_SESSION', authSession());
  });
  expect(hook.result.current.preferenceSession).toBe(current.preferenceSession);
  expect(hook.result.current.preferredLanguage).toBe('de');
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockRead.mock.calls[0][0].isCurrent()).toBe(true);
});

it('recovers from failed initialization only when a valid auth observation arrives', async () => {
  mockGetSession.mockRejectedValue(new Error('Synthetic auth unavailable'));
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(mockRead).not.toHaveBeenCalled();
  await act(async () => { mockAuthListener('INITIAL_SESSION', authSession()); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('fr'));
  expect(mockRead).toHaveBeenCalledTimes(1);
});

it('rolls back an in-flight automatic opt-in before a same-owner replacement reads storage', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  const originalSet = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
  const writing = deferred<void>();
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
    await writing.promise;
    await originalSet(key, value);
  });
  let saving!: ReturnType<typeof hook.result.current.updateAutomaticDubbing>;
  await act(() => { saving = hook.result.current.updateAutomaticDubbing({ userId: 'alice', enabled: true }); });
  await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
  await act(async () => { mockAuthListener('SIGNED_IN', authSession('alice', 'replacement')); });
  await act(async () => { writing.resolve(); expect((await saving).ok).toBe(false); });
  await waitFor(() => expect(hook.result.current.automaticDubbingLoading).toBe(false));
  expect(hook.result.current.automaticDubbingPreference?.enabled).toBe(false);
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
});

it('cleans up each provider subscription and refuses late bootstrap after unmount', async () => {
  const initial = deferred<{ data: { session: Session }; error: null }>();
  mockGetSession.mockReturnValueOnce(initial.promise);
  mockRead.mockResolvedValue(settings('fr'));
  const first = await renderHook(useLanguagePreference, { wrapper });
  const oldListener = mockAuthListener;
  await first.unmount();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  await act(async () => {
    initial.resolve({ data: { session: authSession() }, error: null });
    oldListener('SIGNED_IN', authSession('alice', 'old-provider'));
  });
  expect(mockRead).not.toHaveBeenCalled();
  const current = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(current.result.current.preferredLanguage).toBe('fr'));
  expect(mockGetSession).toHaveBeenCalledTimes(2);
  expect(mockSubscribe).toHaveBeenCalledTimes(2);
  await current.unmount();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
});

it('treats TOKEN_REFRESHED with a genuinely different session id as replacement rather than healthy rotation', async () => {
  mockRead.mockResolvedValueOnce(settings('es')).mockResolvedValueOnce(settings('de'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  const previous = hook.result.current;
  await act(async () => { mockAuthListener('TOKEN_REFRESHED', authSession('alice', 'replacement')); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  expect(hook.result.current.preferenceSession).toBeGreaterThan(previous.preferenceSession);
  expect(mockRead.mock.calls[0][0].isCurrent()).toBe(false);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
});

it('does not accept a late INITIAL_SESSION after a current SDK snapshot has initialized the provider', async () => {
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('fr'));
  const epoch = hook.result.current.preferenceSession;
  await act(async () => { mockAuthListener('INITIAL_SESSION', authSession('alice', 'stale-session')); });
  expect(hook.result.current.preferenceSession).toBe(epoch);
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
});

it('does not read or write preferences if the auth observer cannot be installed', async () => {
  mockSubscribe.mockImplementation(() => { throw new Error('Synthetic observer failure'); });
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(hook.result.current.automaticDubbingPreference).toBeUndefined();
  await act(async () => { expect((await hook.result.current.updateLanguage('es')).ok).toBe(false); });
  expect(mockGetSession).not.toHaveBeenCalled();
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
});

it('signout invalidates pending bootstrap without resurrecting the initial account', async () => {
  const initial = deferred<{ data: { session: Session }; error: null }>();
  mockGetSession.mockReturnValue(initial.promise);
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await act(async () => {
    mockAuthListener('SIGNED_OUT', null);
    initial.resolve({ data: { session: authSession() }, error: null });
  });
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(mockRead).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
});

it('fails closed on an unreadable replacement event and recovers only from a valid subsequent session', async () => {
  mockRead.mockResolvedValueOnce(settings('es')).mockResolvedValueOnce(settings('de'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('es'));
  const previous = hook.result.current;
  await act(async () => { mockAuthListener('SIGNED_IN', authSession('alice', null)); });
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(hook.result.current.automaticDubbingPreference).toBeUndefined();
  expect(mockRead.mock.calls[0][0].isCurrent()).toBe(false);
  await act(async () => { expect((await previous.updateLanguage('fr')).ok).toBe(false); });
  expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => { mockAuthListener('SIGNED_IN', authSession('alice', 'replacement')); });
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('de'));
  expect(mockRead).toHaveBeenCalledTimes(2);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
});

it('invalidates pending initialization when configuration changes and requires a current snapshot on recovery', async () => {
  const initial = deferred<{ data: { session: Session }; error: null }>();
  mockGetSession.mockReturnValueOnce(initial.promise);
  mockRead.mockResolvedValue(settings('fr'));
  const hook = await renderHook(useLanguagePreference, { wrapper });
  mockConfigured = false;
  await hook.rerender({});
  await act(async () => { initial.resolve({ data: { session: authSession() }, error: null }); });
  expect(hook.result.current.preferredLanguage).toBeNull();
  expect(hook.result.current.loading).toBe(false);
  expect(mockRead).not.toHaveBeenCalled();
  mockConfigured = true;
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.preferredLanguage).toBe('fr'));
  expect(mockGetSession).toHaveBeenCalledTimes(2);
  expect(mockSubscribe).toHaveBeenCalledTimes(2);
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});
