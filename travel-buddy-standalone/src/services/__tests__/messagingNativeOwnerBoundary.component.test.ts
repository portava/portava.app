import './configuredSupabaseEnvFixture.ts';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import * as native from 'expo-openmls';
import { supabase } from '../../lib/supabase.ts';
import * as secure from '../../lib/secureStore.ts';
import { realCryptoPort } from '../../lib/e2ee/realPort.ts';
import { openDirectThread, sendMessage } from '../messaging.ts';
import { assertMessagingOwnerRequest, captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../messagingOwnerRequest.ts';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';

jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<AuthCallback>();
  const auth = {
    listeners,
    getSession: jest.fn(),
    refreshSession: jest.fn(),
    onAuthStateChange: jest.fn((callback: AuthCallback) => {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    }),
  };
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: jest.fn(() => ({ auth })) };
});

jest.mock('../../lib/secureStore.ts', () => {
  return {
    isNative: jest.fn(() => true),
    SECURE_KEYS: { MLS_GROUP_STATE_PREFIX: 'group:', DEVICE_ED25519_PRIVATE_KEY: 'priv', DEVICE_ED25519_PUBLIC_KEY: 'pub', MLS_PENDING_KEY_PACKAGE: 'pending' },
    getSecure: jest.fn(), setSecure: jest.fn(), deleteSecure: jest.fn(),
  };
});

jest.mock('expo-openmls', () => {
  return { createGroup: jest.fn(), encryptMessage: jest.fn() };
});

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
type Operation = 'send' | 'open';
type Change = 'owner' | 'relogin' | 'replacement' | 'refresh';
type NativeResult = { ciphertextB64: string; updatedGroupStateB64: string; welcomeB64: string; groupStateB64: string };
const auth = supabase.auth as unknown as {
  listeners: Set<AuthCallback>;
  getSession: jest.Mock;
  refreshSession: jest.Mock;
};
const getSecure = jest.mocked(secure.getSecure);
const setSecure = jest.mocked(secure.setSecure);
const deleteSecure = jest.mocked(secure.deleteSecure);
const encryptMessage = jest.mocked(native.encryptMessage);
const createGroup = jest.mocked(native.createGroup);
const isNative = jest.mocked(secure.isNative);
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const originalFetch = global.fetch;
const originalAtob = global.atob;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const changes: Change[] = ['owner', 'relogin', 'replacement'];
const operations: Operation[] = ['send', 'open'];
const nativeResult: NativeResult = { ciphertextB64: 'ciphertext-only', updatedGroupStateB64: 'A-next', welcomeB64: 'welcome-only', groupStateB64: 'A-created' };
let currentSession: Session | null;
let stored: Map<string, string>;
let errorSpy: jest.SpyInstance;

function session(ownerId = 'owner-A', sessionId = 'session-A1', version = 'initial'): Session {
  return {
    user: { id: ownerId, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-16T00:00:00Z' },
    access_token: `e30.${Buffer.from(JSON.stringify({ sub: ownerId, session_id: sessionId, version })).toString('base64url')}.synthetic`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
  };
}

function emit(event: AuthChangeEvent, value: Session | null) {
  currentSession = value;
  for (const callback of [...auth.listeners]) callback(event, value);
}

function change(kind: Change) {
  if (kind === 'owner') {
    setDiscoveryViewerFromSession('owner-B');
    emit('SIGNED_IN', session('owner-B', 'session-B1'));
  } else if (kind === 'relogin') {
    emit('SIGNED_OUT', null);
    emit('SIGNED_IN', session());
  } else if (kind === 'replacement') emit('SIGNED_IN', session('owner-A', 'session-A2'));
  else emit('TOKEN_REFRESHED', session('owner-A', 'session-A1', 'renewed'));
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function reached(mock: jest.Mock, count = 1) {
  for (let attempt = 0; attempt < 100 && mock.mock.calls.length < count; attempt += 1) await Promise.resolve();
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function invoke(operation: Operation) {
  return operation === 'send'
    ? sendMessage('thread-A', 'A-private-body', { isE2ee: true, clientId: 'client-A', replyToId: 'reply-A' })
    : openDirectThread('recipient');
}

function capturedAssertion() {
  const context = captureMessagingOwnerRequest();
  if (!context) throw new Error('Fixture must have a known owner');
  return () => assertMessagingOwnerRequest(context);
}

function invokePort(operation: Operation, assertion?: () => void) {
  return operation === 'send'
    ? realCryptoPort.encryptForThread('thread-A', 'A-private-body', assertion)
    : realCryptoPort.initGroupAsInitiator('thread-A', 'owner-A', 'peer-package', assertion);
}

function expectNoLaterDispatch(operation: Operation) {
  expect(fetchMock).toHaveBeenCalledTimes(operation === 'send' ? 0 : 2);
  expect(deleteSecure).not.toHaveBeenCalled();
}

beforeEach(() => {
  disposeMessagingOwnerObserver();
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession('owner-A');
  global.atob = value => Buffer.from(value, 'base64').toString('binary');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://example.invalid';
  currentSession = session();
  stored = new Map([['group:thread-A', 'A-initial'], ['priv', 'A-private-key'], ['pub', 'A-public-key']]);
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  getSecure.mockReset().mockImplementation(async key => stored.get(key) ?? null);
  setSecure.mockReset().mockImplementation(async (key, value) => { stored.set(key, value); });
  deleteSecure.mockReset();
  isNative.mockReset().mockReturnValue(true);
  encryptMessage.mockReset().mockResolvedValue(nativeResult);
  createGroup.mockReset().mockResolvedValue(nativeResult);
  fetchMock.mockReset().mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    const data = path.endsWith('/open-thread') ? { threadId: 'thread-A', created: true }
      : path.endsWith('/key-packages/consume') ? { keyPackageB64: 'peer-package', deviceId: 'peer-device' }
      : { id: 'message-A', ok: true };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  global.fetch = fetchMock;
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  initializeMessagingOwnerObserver();
  emit('INITIAL_SESSION', currentSession);
});

afterEach(() => {
  disposeMessagingOwnerObserver();
  expect(auth.listeners.size).toBe(0);
  global.fetch = originalFetch;
  global.atob = originalAtob;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  errorSpy.mockRestore();
  _resetDiscoveryViewerScopeForTests();
});

describe.each(changes)('actual native boundary after %s', kind => {
  it.each([1, 2])('stops encryption after group-state lookup %s becomes stale', async lookup => {
    const gate = deferred<string | null>();
    if (lookup === 2) getSecure.mockResolvedValueOnce('A-initial');
    getSecure.mockReturnValueOnce(gate.promise);
    const pending = invoke('send');
    await reached(getSecure, lookup);
    change(kind);
    gate.resolve('A-initial');
    expect(await pending).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
    expect(encryptMessage).not.toHaveBeenCalled();
    expect(setSecure).not.toHaveBeenCalled();
    expectNoLaterDispatch('send');
  });

  it.each(['priv', 'pub'])('stops group creation after the %s key read becomes stale', async key => {
    const gate = deferred<string | null>();
    getSecure.mockImplementation(name => name === key ? gate.promise : Promise.resolve(stored.get(name) ?? null));
    const pending = invoke('open');
    await reached(getSecure, 2);
    change(kind);
    gate.resolve('late-key');
    expect(await pending).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
    expect(createGroup).not.toHaveBeenCalled();
    expect(setSecure).not.toHaveBeenCalled();
    expectNoLaterDispatch('open');
  });

  it.each(operations)('does not persist a late %s native result or restore cleared state', async operation => {
    const gate = deferred<NativeResult>();
    const nativeOperation = operation === 'send' ? encryptMessage : createGroup;
    nativeOperation.mockReturnValueOnce(gate.promise);
    const pending = invoke(operation);
    await reached(nativeOperation);
    change(kind);
    stored.delete('group:thread-A');
    gate.resolve(nativeResult);
    expect(await pending).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
    expect(setSecure).not.toHaveBeenCalled();
    expect(stored.has('group:thread-A')).toBe(false);
    expectNoLaterDispatch(operation);
  });

  it.each(operations)('withholds %s completion but does not claim to cancel already-started persistence', async operation => {
    const gate = deferred<void>();
    setSecure.mockImplementationOnce(async (key, value) => { await gate.promise; stored.set(key, value); });
    const pending = invoke(operation);
    await reached(setSecure);
    change(kind);
    stored.delete('group:thread-A');
    gate.resolve();
    expect(await pending).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
    expect(stored.get('group:thread-A')).toBe(operation === 'send' ? 'A-next' : 'A-created');
    expect(setSecure).toHaveBeenCalledTimes(1);
    expectNoLaterDispatch(operation);
  });
});

describe.each(operations)('%s actual native controls', operation => {
  it.each(['state', 'native', 'persistence'])('permits same-session token refresh during %s', async stage => {
    const stateGate = deferred<string | null>();
    const nativeGate = deferred<NativeResult>();
    const storageGate = deferred<void>();
    const nativeOperation = operation === 'send' ? encryptMessage : createGroup;
    if (stage === 'state') {
      if (operation === 'send') getSecure.mockResolvedValueOnce('A-initial');
      getSecure.mockReturnValueOnce(stateGate.promise);
    } else if (stage === 'native') nativeOperation.mockReturnValueOnce(nativeGate.promise);
    else setSecure.mockImplementationOnce(async (key, value) => { await storageGate.promise; stored.set(key, value); });
    const pending = invoke(operation);
    await reached(stage === 'state' ? getSecure : stage === 'native' ? nativeOperation : setSecure, stage === 'state' ? 2 : 1);
    change('refresh');
    if (stage === 'state') stateGate.resolve(operation === 'send' ? 'A-initial' : 'A-private-key');
    else if (stage === 'native') nativeGate.resolve(nativeResult);
    else storageGate.resolve();
    expect((await pending).ok).toBe(true);
    expect(setSecure).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(operation === 'send' ? 1 : 4);
    const sent = fetchMock.mock.calls[operation === 'send' ? 0 : 2][1];
    expect(JSON.parse(String(sent?.body))).toEqual(operation === 'send'
      ? { ciphertext: 'ciphertext-only', clientId: 'client-A', replyToId: 'reply-A', idempotencyKey: 'client-A' }
      : { body: 'welcome-only', msgType: 'system', subtype: 'e2ee_welcome' });
    expect((sent?.headers as Record<string, string>).Authorization).toBe(`Bearer ${currentSession?.access_token}`);
    expect(deleteSecure).not.toHaveBeenCalled();
  });

  it.each(['state', 'native', 'persistence'])('preserves the original %s rejection at the opted-in real port', async stage => {
    const error = new Error(`synthetic ${stage} failure`);
    if (stage === 'state') getSecure.mockRejectedValueOnce(error);
    else if (stage === 'native') (operation === 'send' ? encryptMessage : createGroup).mockRejectedValueOnce(error);
    else setSecure.mockRejectedValueOnce(error);
    await expect(invokePort(operation, capturedAssertion())).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
    if (stage !== 'persistence') expect(setSecure).not.toHaveBeenCalled();
    expect(deleteSecure).not.toHaveBeenCalled();
  });

  it.each(['state', 'native', 'persistence'])('keeps the existing public %s failure contract', async stage => {
    const error = new Error(`synthetic ${stage} failure`);
    if (stage === 'state') {
      if (operation === 'send') getSecure.mockResolvedValueOnce('A-initial');
      getSecure.mockRejectedValueOnce(error);
    } else if (stage === 'native') (operation === 'send' ? encryptMessage : createGroup).mockRejectedValueOnce(error);
    else setSecure.mockRejectedValueOnce(error);
    if (operation === 'send') await expect(invoke(operation)).rejects.toMatchObject({ reason: 'encrypt_failed' });
    else expect((await invoke(operation)).ok).toBe(true);
    expectNoLaterDispatch(operation);
  });

  it('refuses an already stale opted-in port before any storage/native work', async () => {
    const assertion = capturedAssertion();
    change('replacement');
    await expect(invokePort(operation, assertion)).rejects.toThrow('signed-in messaging session changed');
    expect(getSecure).not.toHaveBeenCalled();
    expect(encryptMessage).not.toHaveBeenCalled();
    expect(createGroup).not.toHaveBeenCalled();
    expect(setSecure).not.toHaveBeenCalled();
  });

  it('checks the opted-in port again after persistence before returning its result', async () => {
    const gate = deferred<void>();
    setSecure.mockReturnValueOnce(gate.promise);
    const pending = invokePort(operation, capturedAssertion());
    await reached(setSecure);
    change('replacement');
    gate.resolve();
    await expect(pending).rejects.toThrow('signed-in messaging session changed');
    expect(setSecure).toHaveBeenCalledTimes(1);
    expect(deleteSecure).not.toHaveBeenCalled();
  });

  it('leaves explicitly unscoped real-port callers unchanged', async () => {
    const gate = deferred<NativeResult>();
    const nativeOperation = operation === 'send' ? encryptMessage : createGroup;
    nativeOperation.mockReturnValueOnce(gate.promise);
    const pending = invokePort(operation);
    await reached(nativeOperation);
    change('replacement');
    gate.resolve(nativeResult);
    expect(await pending).toEqual(operation === 'send' ? 'ciphertext-only' : { welcomeB64: 'welcome-only' });
    expect(setSecure).toHaveBeenCalledTimes(1);
    expect(deleteSecure).not.toHaveBeenCalled();
  });

  it('keeps native-unavailable refusal without fallback or persistence', async () => {
    isNative.mockReturnValue(false);
    if (operation === 'send') await expect(invoke(operation)).rejects.toMatchObject({ reason: 'no_native_module' });
    else expect((await invoke(operation)).ok).toBe(true);
    expect(setSecure).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(operation === 'send' ? 0 : 1);
  });
});
