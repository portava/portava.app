import './configuredSupabaseEnvFixture.ts';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase.ts';
import { realCryptoPort } from '../../lib/e2ee/realPort.ts';
import { openDirectThread, sendMessage, getMyMessageSettings, updateMyMessageSettings } from '../messaging.ts';
import { shareObjectIntoThread, resolveShareProjections } from '../../features/telegraph/sharing/shareApi.ts';
import { captureMessagingOwnerRequest, initializeMessagingOwnerObserver, disposeMessagingOwnerObserver } from '../messagingOwnerRequest.ts';
import { currentDiscoveryScope, setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';

jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<AuthCallback>();
  const auth = {
    getSession: jest.fn(),
    refreshSession: jest.fn(),
    listeners,
    onAuthStateChange: jest.fn((callback: AuthCallback) => {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: jest.fn(() => listeners.delete(callback)) } } };
    }),
  };
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: jest.fn(() => ({ auth })) };
});

jest.mock('../../lib/e2ee/realPort.ts', () => {
  return { realCryptoPort: {
    isNative: jest.fn(),
    hasGroupSession: jest.fn(),
    encryptForThread: jest.fn(),
    initGroupAsInitiator: jest.fn(),
  } };
});

jest.mock('../../features/telegraph/connection/connectionMonitor.ts', () => {
  return { noteTelegraphRequest: jest.fn() };
});

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
const auth = supabase.auth as unknown as {
  getSession: jest.Mock;
  refreshSession: jest.Mock;
  onAuthStateChange: jest.Mock;
  listeners: Set<AuthCallback>;
};
const crypto = jest.mocked(realCryptoPort);
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const originalAtob = global.atob;
const transports = ['open', 'send', 'share'] as const;
type Transport = typeof transports[number];
let currentSession: Session | null;
let newlyCreated = false;

function token(ownerId = 'owner-A', sessionId: unknown = 'session-A1', version = 'initial') {
  return `e30.${Buffer.from(JSON.stringify({ sub: ownerId, session_id: sessionId, version })).toString('base64url')}.synthetic`;
}

function session(ownerId = 'owner-A', sessionId = 'session-A1', expired = false, version = 'initial'): Session {
  return {
    user: { id: ownerId, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-16T00:00:00Z' },
    access_token: token(ownerId, sessionId, version), refresh_token: 'synthetic-refresh', token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600), expires_in: 3600,
  };
}

function emit(event: AuthChangeEvent, value: Session | null) {
  currentSession = value;
  for (const callback of [...auth.listeners]) callback(event, value);
}

function switchAccount() {
  setDiscoveryViewerFromSession('owner-B');
  emit('SIGNED_IN', session('owner-B', 'session-B1'));
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function reached(mock: jest.Mock, count = 1) {
  for (let attempt = 0; attempt < 40 && mock.mock.calls.length < count; attempt += 1) await Promise.resolve();
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => name === 'Retry-After' ? '9' : null }, json: async () => data } as Response;
}

function routeData(path: string): unknown {
  if (path.endsWith('/open-thread')) return { threadId: 'thread-one', created: newlyCreated };
  if (path.endsWith('/key-packages/consume')) return { keyPackageB64: 'peer-package', deviceId: 'peer-device' };
  return { id: 'message-one', ok: true };
}

function pathFor(input: Parameters<typeof fetch>[0]) { return new URL(String(input)).pathname; }
function wirePaths() { return fetchMock.mock.calls.map(([input]) => pathFor(input)); }
function invoke(transport: Transport) {
  if (transport === 'open') return openDirectThread('recipient');
  if (transport === 'share') return shareObjectIntoThread('thread-one', 'POST', 'post-one', 'Original intent');
  return sendMessage('thread-one', 'Original intent', { msgType: 'system', subtype: 'post_card', clientId: 'client-one', replyToId: 'reply-one' });
}

beforeEach(() => {
  disposeMessagingOwnerObserver();
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession('owner-A');
  global.atob = value => Buffer.from(value, 'base64').toString('binary');
  currentSession = session();
  newlyCreated = false;
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.onAuthStateChange.mockClear();
  crypto.isNative.mockReset().mockReturnValue(true);
  crypto.hasGroupSession.mockReset().mockResolvedValue(true);
  crypto.encryptForThread.mockReset().mockResolvedValue('ciphertext-only');
  crypto.initGroupAsInitiator.mockReset().mockResolvedValue({ welcomeB64: 'welcome-only' });
  fetchMock.mockReset().mockImplementation(async input => jsonResponse(routeData(pathFor(input))));
  global.fetch = fetchMock;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://example.invalid';
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
  _resetDiscoveryViewerScopeForTests();
});

describe('messaging owner observer', () => {
  it('does not bind an uninitialized intent to a later initial session', async () => {
    disposeMessagingOwnerObserver();
    initializeMessagingOwnerObserver();
    const pending = transports.map(invoke);
    switchAccount();
    emit('INITIAL_SESSION', currentSession);
    for (const result of await Promise.all(pending)) expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(captureMessagingOwnerRequest()?.ownerId).toBe('owner-B');
    expect((await invoke('send')).ok).toBe(true);
  });

  it('ignores late initialization after a newer auth event and does not revive disposed contexts', () => {
    const oldCallback = [...auth.listeners][0];
    const old = captureMessagingOwnerRequest();
    emit('SIGNED_OUT', null);
    emit('INITIAL_SESSION', session());
    expect(captureMessagingOwnerRequest()).toBeNull();
    expect(old?.isCurrent()).toBe(false);
    disposeMessagingOwnerObserver();
    initializeMessagingOwnerObserver();
    emit('INITIAL_SESSION', session());
    const current = captureMessagingOwnerRequest();
    oldCallback('SIGNED_IN', session('owner-B', 'session-B1'));
    expect(current?.isCurrent()).toBe(true);
    expect(old?.isCurrent()).toBe(false);
  });

  it('keeps one subscription across requests, initialization and repeated module evaluation', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      initializeMessagingOwnerObserver();
      expect(captureMessagingOwnerRequest()?.isCurrent()).toBe(true);
    }
    jest.doMock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: { auth } }));
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        jest.isolateModules(() => { require('../messagingOwnerRequest.ts'); });
      }
    } finally { jest.dontMock('../../lib/supabase.ts'); }
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(auth.listeners.size).toBe(1);
    const subscription = auth.onAuthStateChange.mock.results[0].value.data.subscription;
    disposeMessagingOwnerObserver();
    disposeMessagingOwnerObserver();
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails safely without retry subscriptions when registration throws', () => {
    disposeMessagingOwnerObserver();
    auth.onAuthStateChange.mockClear().mockImplementationOnce(() => { throw new Error('registration failed'); });
    initializeMessagingOwnerObserver();
    expect(captureMessagingOwnerRequest()).toBeNull();
    expect(captureMessagingOwnerRequest()).toBeNull();
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });

  it('accepts synchronous initialization and removes that subscription on cleanup', () => {
    disposeMessagingOwnerObserver();
    const unsubscribe = jest.fn();
    auth.onAuthStateChange.mockImplementationOnce((callback: AuthCallback) => {
      callback('INITIAL_SESSION', session());
      return { data: { subscription: { unsubscribe } } };
    });
    initializeMessagingOwnerObserver();
    const context = captureMessagingOwnerRequest();
    expect(context?.isCurrent()).toBe(true);
    disposeMessagingOwnerObserver();
    expect(context?.isCurrent()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and invalidates the original observer when the auth client is replaced', () => {
    const context = captureMessagingOwnerRequest();
    const originalSubscription = auth.onAuthStateChange.mock.results[0].value.data.subscription;
    const unsubscribe = jest.fn();
    const replacement = { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe } } })) };
    jest.doMock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: { auth: replacement } }));
    try {
      jest.isolateModules(() => { require('../messagingOwnerRequest.ts'); });
      expect(context?.isCurrent()).toBe(false);
      expect(originalSubscription.unsubscribe).toHaveBeenCalledTimes(1);
      expect(auth.listeners.size).toBe(0);
      expect(replacement.onAuthStateChange).toHaveBeenCalledTimes(1);
      disposeMessagingOwnerObserver();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally { jest.dontMock('../../lib/supabase.ts'); }
  });

  it.each(['unknown-viewer', 'signed-out-initial', 'missing-user', 'empty-token'])('fails safely for %s at intent entry', async state => {
    if (state === 'unknown-viewer') _resetDiscoveryViewerScopeForTests();
    else {
      disposeMessagingOwnerObserver();
      initializeMessagingOwnerObserver();
      const initial = state === 'signed-out-initial' ? null : session();
      if (initial && state === 'missing-user') initial.user.id = '';
      if (initial && state === 'empty-token') initial.access_token = '';
      emit('INITIAL_SESSION', initial);
    }
    for (const result of await Promise.all(transports.map(invoke))) expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it.each([null, '', 5, {}, '   '])('rejects malformed session_id %p without adopting a late token', async (sessionId) => {
    const invalid = { ...session(), access_token: token('owner-A', sessionId) };
    emit('TOKEN_REFRESHED', invalid);
    expect(captureMessagingOwnerRequest()).toBeNull();
    expect((await invoke('send')).ok).toBe(false);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'subject-mismatch', 'missing-decoder'])('rejects %s identity', kind => {
    const invalid = session();
    emit('SIGNED_OUT', null);
    if (kind === 'malformed') invalid.access_token = 'not-a-jwt';
    else if (kind === 'subject-mismatch') invalid.access_token = token('owner-B', 'session-B1');
    else Reflect.deleteProperty(globalThis, 'atob');
    emit('SIGNED_IN', invalid);
    expect(captureMessagingOwnerRequest()).toBeNull();
  });

  it('requires agreement between observed auth identity and the existing viewer scope', () => {
    setDiscoveryViewerFromSession('owner-B');
    expect(captureMessagingOwnerRequest()).toBeNull();
    emit('SIGNED_IN', session('owner-B', 'session-B1'));
    expect(captureMessagingOwnerRequest()?.ownerId).toBe('owner-B');
  });

  it('keeps immutable contexts current for same-session refresh but not replacement or sign-out', () => {
    const context = captureMessagingOwnerRequest();
    expect(Object.isFrozen(context)).toBe(true);
    emit('TOKEN_REFRESHED', session('owner-A', 'session-A1', false, 'renewed'));
    emit('SIGNED_IN', session('owner-A', 'session-A1', false, 'confirmed'));
    expect(context?.isCurrent()).toBe(true);
    const scope = currentDiscoveryScope();
    emit('SIGNED_IN', session('owner-A', 'session-A2'));
    expect(currentDiscoveryScope()).toEqual(scope);
    expect(context?.isCurrent()).toBe(false);
    const next = captureMessagingOwnerRequest();
    emit('SIGNED_OUT', null);
    emit('SIGNED_IN', session('owner-A', 'session-A2'));
    expect(next?.isCurrent()).toBe(false);
  });
});

describe.each(transports)('%s actual owner-bound transport', transport => {
  it.each(['getSession', 'refreshSession'])('rejects another owner after %s even before an auth event arrives', async (method) => {
    const gate = deferred<{ data: { session: Session } }>();
    if (method === 'refreshSession') auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-A', 'session-A1', true) } });
    auth[method as 'getSession' | 'refreshSession'].mockReturnValueOnce(gate.promise);
    const pending = invoke(transport);
    await reached(auth[method as 'getSession' | 'refreshSession']);
    gate.resolve({ data: { session: session('owner-B', 'session-B1') } });
    expect((await pending).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['different-owner', 'same-owner-session', 'signed-out-back', 'epoch-only'])('rejects %s during token lookup', async (change) => {
    const gate = deferred<{ data: { session: Session } }>();
    auth.getSession.mockReturnValueOnce(gate.promise);
    const pending = invoke(transport);
    await reached(auth.getSession);
    if (change === 'different-owner') switchAccount();
    else if (change === 'same-owner-session') emit('SIGNED_IN', session('owner-A', 'session-A2'));
    else if (change === 'signed-out-back') { emit('SIGNED_OUT', null); emit('SIGNED_IN', session()); }
    else { setDiscoveryViewerFromSession(null); setDiscoveryViewerFromSession('owner-A'); }
    gate.resolve({ data: { session: session() } });
    expect((await pending).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a different session_id returned without an observer event', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-A', 'session-A2') } });
    expect((await invoke(transport)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an absent session unauthenticated without dispatch', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    auth.refreshSession.mockResolvedValueOnce({ data: { session: null } });
    expect((await invoke(transport)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['getSession', 'refreshSession'])('handles rejected %s without dispatch', async (method) => {
    if (method === 'refreshSession') auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-A', 'session-A1', true) } });
    auth[method as 'getSession' | 'refreshSession'].mockRejectedValueOnce(new Error('auth unavailable'));
    expect((await invoke(transport)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([200, 403])('withholds late parsed HTTP %s data after owner change', async (status) => {
    const gate = deferred<unknown>();
    const json = jest.fn(() => gate.promise);
    fetchMock.mockResolvedValueOnce({ ...jsonResponse({}, status), json });
    const pending = invoke(transport);
    await reached(json);
    switchAccount();
    gate.resolve({ id: 'old-owner-data', error: 'forbidden' });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('data.id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('withholds late rejected JSON', async () => {
    const gate = deferred<unknown>();
    const json = jest.fn(() => gate.promise);
    fetchMock.mockResolvedValueOnce({ ...jsonResponse({}), json });
    const pending = invoke(transport);
    await reached(json);
    switchAccount();
    gate.reject(new Error('late invalid JSON'));
    expect((await pending).ok).toBe(false);
  });

  it.each(['resolved', 'rejected'])('withholds a late %s network response', async outcome => {
    const gate = deferred<Response>();
    const json = jest.fn(async () => ({ id: 'old-owner-data' }));
    fetchMock.mockReturnValueOnce(gate.promise);
    const pending = invoke(transport);
    await reached(fetchMock);
    switchAccount();
    if (outcome === 'resolved') gate.resolve({ ...jsonResponse({}), json });
    else gate.reject(new Error('Network request failed'));
    const result = await pending;
    expect(result).toMatchObject(transport === 'share'
      ? { ok: false, error: 'unauthenticated' }
      : { ok: false, data: null, errorKind: 'unauthenticated' });
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows token rotation within the same owner/session and keeps one subscription', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-A', 'session-A1', true) } });
    auth.refreshSession.mockImplementationOnce(async () => {
      emit('TOKEN_REFRESHED', session('owner-A', 'session-A1', false, 'renewed'));
      return { data: { session: currentSession } };
    });
    expect((await invoke(transport)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token('owner-A', 'session-A1', 'renewed')}`);
  });

  it('retains the existing forbidden error contract', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden', message: 'Denied' }, 403));
    const result = await invoke(transport);
    expect(result).toMatchObject(transport === 'share' ? { ok: false, error: 'forbidden' } : { ok: false, data: null, errorKind: 'forbidden', message: 'Denied' });
  });
});

describe('message preparation and existing contracts', () => {
  it('captures the owner before even the plaintext payload await', async () => {
    const pending = invoke('send');
    expect(auth.getSession).not.toHaveBeenCalled();
    switchAccount();
    expect((await pending).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['hasGroupSession', 'encryptForThread'])('stops after a stale %s await without a plaintext fallback', async (stage) => {
    const sessionGate = deferred<boolean>();
    const encryptionGate = deferred<string | null>();
    const operation = stage === 'hasGroupSession' ? crypto.hasGroupSession : crypto.encryptForThread;
    if (stage === 'hasGroupSession') crypto.hasGroupSession.mockReturnValueOnce(sessionGate.promise);
    else crypto.encryptForThread.mockReturnValueOnce(encryptionGate.promise);
    const pending = sendMessage('thread-one', 'secret-body', { isE2ee: true });
    await reached(operation);
    switchAccount();
    if (stage === 'hasGroupSession') sessionGate.resolve(true);
    else encryptionGate.resolve('ciphertext-only');
    expect((await pending).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    if (stage === 'hasGroupSession') expect(crypto.encryptForThread).not.toHaveBeenCalled();
  });

  it('preserves native encryption failure rather than sending plaintext', async () => {
    crypto.encryptForThread.mockRejectedValueOnce(new Error('encryption failed'));
    await expect(sendMessage('thread-one', 'secret-body', { isE2ee: true })).rejects.toMatchObject({ reason: 'encrypt_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves payload, reply/client ID and idempotency identity for encrypted=%s', async (isE2ee) => {
    const options = { isE2ee, msgType: 'text', subtype: 'note', clientId: 'client-one', replyToId: 'reply-one' };
    expect((await sendMessage('thread-one', 'secret-body', options)).ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      ...(isE2ee ? { ciphertext: 'ciphertext-only' } : { body: 'secret-body' }),
      msgType: 'text', subtype: 'note', clientId: 'client-one', replyToId: 'reply-one', idempotencyKey: 'client-one',
    });
  });

  it('preserves rate-limit retry information', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', message: 'Wait' }, 429));
    expect(await invoke('send')).toEqual({ ok: false, data: null, errorKind: 'rate_limited', message: 'Wait', retryAfterSeconds: 9 });
  });

  it('does not apply the owner context to unrelated private helper callers', async () => {
    disposeMessagingOwnerObserver();
    expect((await getMyMessageSettings()).ok).toBe(true);
    expect((await updateMyMessageSettings({ allow_message_requests: false })).ok).toBe(true);
    expect((await resolveShareProjections('thread-one', [{ objectType: 'POST', objectId: 'post-one' }])).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(auth.listeners.size).toBe(0);
  });
});

describe('created-thread negotiation retains one original context', () => {
  const stages = ['open-token', 'open-json', 'consume-token', 'consume-json', 'create-native', 'welcome-token', 'welcome-json', 'mark-token', 'mark-json'] as const;
  const paths = ['/api/users/recipient/open-thread', '/api/users/recipient/key-packages/consume', '/api/threads/thread-one/messages', '/api/threads/thread-one/e2ee'];

  it.each(stages)('refuses later work and results after invalidation at %s', async (stage) => {
    newlyCreated = true;
    const arrived = deferred<void>();
    const gate = deferred<unknown>();
    const tokenStage = { 'open-token': 1, 'consume-token': 2, 'welcome-token': 3, 'mark-token': 4 };
    const jsonStage = { 'open-json': paths[0], 'consume-json': paths[1], 'welcome-json': paths[2], 'mark-json': paths[3] };
    if (stage in tokenStage) {
      auth.getSession.mockImplementation(() => {
        if (auth.getSession.mock.calls.length === tokenStage[stage as keyof typeof tokenStage]) {
          arrived.resolve();
          return gate.promise;
        }
        return Promise.resolve({ data: { session: currentSession } });
      });
    } else if (stage in jsonStage) {
      fetchMock.mockImplementation(async input => {
        if (pathFor(input) === jsonStage[stage as keyof typeof jsonStage]) {
          return { ...jsonResponse({}), json: () => { arrived.resolve(); return gate.promise; } };
        }
        return jsonResponse(routeData(pathFor(input)));
      });
    } else {
      crypto.initGroupAsInitiator.mockImplementationOnce(async () => {
        arrived.resolve();
        await gate.promise;
        return { welcomeB64: 'welcome-only' };
      });
    }
    const pending = openDirectThread('recipient');
    await arrived.promise;
    const dispatched = fetchMock.mock.calls.length;
    switchAccount();
    gate.resolve(stage in tokenStage ? { data: { session: session() } }
      : stage in jsonStage ? routeData(jsonStage[stage as keyof typeof jsonStage]) : null);
    const result = await pending;
    expect(result).toEqual({ ok: false, data: null, errorKind: 'unauthenticated' });
    expect(fetchMock).toHaveBeenCalledTimes(dispatched);
    expect(wirePaths()).toEqual(paths.slice(0, dispatched));
    for (const [, init] of fetchMock.mock.calls) expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token()}`);
    if (stage === 'consume-json') expect(crypto.initGroupAsInitiator).not.toHaveBeenCalled();
  });

  it('keeps the complete consume/create/welcome/mark order, owner, and wire payloads', async () => {
    newlyCreated = true;
    expect(await openDirectThread('recipient')).toEqual({ ok: true, data: { threadId: 'thread-one', created: true } });
    expect(wirePaths()).toEqual(paths);
    expect(crypto.initGroupAsInitiator).toHaveBeenCalledWith('thread-one', 'owner-A', 'peer-package', expect.any(Function));
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ body: 'welcome-only', msgType: 'system', subtype: 'e2ee_welcome' });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({});
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });

  it('keeps a current failed negotiation usable without issuing welcome or mark', async () => {
    newlyCreated = true;
    crypto.initGroupAsInitiator.mockResolvedValueOnce(null);
    expect((await openDirectThread('recipient')).ok).toBe(true);
    expect(wirePaths()).toEqual(paths.slice(0, 2));
  });

  it.each([2, 3, 4])('invalidates the whole negotiation if nested token acquisition %s changes owner without an event', async stage => {
    newlyCreated = true;
    auth.getSession.mockImplementation(async () => ({
      data: { session: auth.getSession.mock.calls.length === stage ? session('owner-B', 'session-B1') : currentSession },
    }));
    expect(await openDirectThread('recipient')).toEqual({ ok: false, data: null, errorKind: 'unauthenticated' });
    expect(wirePaths()).toEqual(paths.slice(0, stage - 1));
    for (const [, init] of fetchMock.mock.calls) expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token()}`);
  });
});
