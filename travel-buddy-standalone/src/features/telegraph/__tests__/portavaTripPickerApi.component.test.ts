import '../../../services/__tests__/configuredSupabaseEnvFixture.ts';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { supabase } from '../../../lib/supabase.ts';
import { captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../../services/messagingOwnerRequest.ts';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../../../services/discoveryViewerScope.ts';
import { loadOwnedTripChoices, shareOwnedTripReference, type PortavaTripIntent } from '../composer/portavaTripPickerApi.ts';

jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<AuthCallback>();
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: jest.fn(() => ({ auth: {
    listeners, getSession: jest.fn(), refreshSession: jest.fn(),
    onAuthStateChange: jest.fn((callback: AuthCallback) => {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    }),
  } })) };
});

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const THREAD = '20000000-0000-4000-8000-000000000001';
const TRIP = '30000000-0000-4000-8000-000000000001';
const MESSAGE = '40000000-0000-4000-8000-000000000001';
const auth = supabase.auth as unknown as { listeners: Set<AuthCallback>; getSession: jest.Mock; refreshSession: jest.Mock };
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const originalFetch = global.fetch;
const originalAtob = global.atob;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let authSession: Session | null;
let controller: AbortController;

function session(ownerId = OWNER, sessionId = 'session-one', version = 'initial'): Session {
  return {
    user: { id: ownerId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T00:00:00Z' },
    access_token: `e30.${Buffer.from(JSON.stringify({ sub: ownerId, session_id: sessionId, version })).toString('base64url')}.test`,
    refresh_token: 'dummy', token_type: 'bearer', expires_at: Date.now() / 1000 + 3600, expires_in: 3600,
  };
}

function emit(event: AuthChangeEvent, next: Session | null) {
  authSession = next;
  for (const listener of auth.listeners) listener(event, next);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

function success() {
  return { id: MESSAGE, senderId: OWNER, threadId: THREAD, msgType: 'portava_object', subtype: 'trip',
    share: { kind: 'PORTAVA_OBJECT', objectType: 'TRIP', objectId: TRIP, caption: null, shareProjectionVersion: '1' } };
}

function intent(): PortavaTripIntent {
  const owner = captureMessagingOwnerRequest();
  if (!owner) throw new Error('Missing controlled owner');
  return { generation: 1, threadId: THREAD, owner, signal: controller.signal, isCurrent: () => !controller.signal.aborted };
}

async function reached(mock: jest.Mock) {
  for (let count = 0; count < 30 && mock.mock.calls.length === 0; count += 1) await Promise.resolve();
  expect(mock).toHaveBeenCalled();
}

beforeEach(() => {
  disposeMessagingOwnerObserver(); _resetDiscoveryViewerScopeForTests();
  global.atob = value => Buffer.from(value, 'base64').toString('binary');
  setDiscoveryViewerFromSession(OWNER);
  authSession = session();
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: authSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: authSession } }));
  initializeMessagingOwnerObserver(); emit('INITIAL_SESSION', authSession);
  controller = new AbortController();
  global.fetch = fetchMock;
  fetchMock.mockReset().mockResolvedValue(response(success(), 201));
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.invalid';
});

afterEach(() => {
  disposeMessagingOwnerObserver(); _resetDiscoveryViewerScopeForTests();
  expect(auth.listeners.size).toBe(0);
  global.fetch = originalFetch; global.atob = originalAtob;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('reads only owned choices and strips all private metadata from picker state', async () => {
  fetchMock.mockResolvedValue(response({ trips: [
    { id: TRIP, ownerId: OWNER, title: 'My private trip', destinationLat: 10, tripNotes: 'secret' },
    { id: 'foreign-trip', ownerId: OTHER, title: 'Foreign title' },
  ] }));
  expect(await loadOwnedTripChoices(intent())).toEqual({ ok: true, trips: [{ id: TRIP, title: 'My private trip' }] });
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.invalid/api/trips/me');
});

it('sends exactly a canonical reference with the original owner token', async () => {
  expect(await shareOwnedTripReference(intent(), TRIP)).toEqual({ ok: true, messageId: MESSAGE });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(`https://api.example.invalid/api/threads/${THREAD}/share`);
  const init = fetchMock.mock.calls[0][1];
  expect(JSON.parse(String(init?.body))).toEqual({ objectType: 'TRIP', objectId: TRIP, caption: null });
  expect(init?.headers).toEqual({ Authorization: `Bearer ${authSession?.access_token}`, 'Content-Type': 'application/json' });
});

it.each([null, {}, { trips: null }, { trips: [null] }, { trips: [{ ownerId: OWNER, id: 'bad', title: 'bad' }] }])('does not report malformed trip reads as empty: %p', async data => {
  fetchMock.mockResolvedValue(response(data));
  expect(await loadOwnedTripChoices(intent())).toMatchObject({ ok: false, reason: 'unavailable' });
});

it.each([400, 403, 409, 429])('preserves an explicit server refusal %s without retrying', async status => {
  fetchMock.mockResolvedValue(response({ message: 'You cannot share this object' }, status));
  expect(await shareOwnedTripReference(intent(), TRIP)).toEqual({ ok: false, reason: 'refused', message: 'You cannot share this object' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([null, {}, { ...success(), threadId: 'wrong' }, { ...success(), senderId: OTHER }, { ...success(), share: { ...success().share, objectId: 'wrong' } }])('does not confirm a malformed/mismatched receipt: %p', async data => {
  fetchMock.mockResolvedValue(response(data));
  expect(await shareOwnedTripReference(intent(), TRIP)).toMatchObject({ ok: false, reason: 'unknown' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['503', 'throw', 'json'])('marks an ambiguous send %s unknown, never auto-retries', async failure => {
  if (failure === '503') fetchMock.mockResolvedValue(response({}, 503));
  else if (failure === 'throw') fetchMock.mockRejectedValue(new Error('network'));
  else fetchMock.mockResolvedValue({ ...response(null, 201), json: async () => { throw new Error('parse'); } });
  expect(await shareOwnedTripReference(intent(), TRIP)).toMatchObject({ ok: false, reason: 'unknown' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['read', 'share'] as const)('stops %s when close/thread switch invalidates during token await', async operation => {
  const pending = deferred<{ data: { session: Session | null } }>();
  auth.getSession.mockReturnValue(pending.promise);
  const scope = intent();
  const result = operation === 'read' ? loadOwnedTripChoices(scope) : shareOwnedTripReference(scope, TRIP);
  controller.abort(); pending.resolve({ data: { session: authSession } });
  expect(await result).toMatchObject({ ok: false, reason: 'stale' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['account', 'session', 'signout'] as const)('stops original intent after %s changes during auth await', async change => {
  const pending = deferred<{ data: { session: Session | null } }>();
  auth.getSession.mockReturnValue(pending.promise);
  const result = shareOwnedTripReference(intent(), TRIP);
  if (change === 'account') { setDiscoveryViewerFromSession(OTHER); emit('SIGNED_IN', session(OTHER)); }
  if (change === 'session') emit('SIGNED_IN', session(OWNER, 'replacement'));
  if (change === 'signout') emit('SIGNED_OUT', null);
  pending.resolve({ data: { session: authSession } });
  expect(await result).toMatchObject({ ok: false, reason: 'stale' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('allows TOKEN_REFRESHED within the same owner/session', async () => {
  const scope = intent();
  emit('TOKEN_REFRESHED', session(OWNER, 'session-one', 'refreshed'));
  expect(await shareOwnedTripReference(scope, TRIP)).toMatchObject({ ok: true });
});

it('does not lazily bind an intent before observer initialization', () => {
  disposeMessagingOwnerObserver(); initializeMessagingOwnerObserver();
  expect(captureMessagingOwnerRequest()).toBeNull();
  expect(auth.listeners.size).toBe(1);
});

it('rejects failed auth and sends no request', async () => {
  auth.getSession.mockRejectedValue(new Error('auth'));
  expect(await shareOwnedTripReference(intent(), TRIP)).toMatchObject({ ok: false, reason: 'stale' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['read', 'share'] as const)('discards %s JSON arriving after replacement', async operation => {
  const pending = deferred<unknown>();
  const json = jest.fn(() => pending.promise);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json } as unknown as Response);
  const scope = intent();
  const result = operation === 'read' ? loadOwnedTripChoices(scope) : shareOwnedTripReference(scope, TRIP);
  await reached(json);
  emit('SIGNED_IN', session(OWNER, 'new-session'));
  pending.resolve(operation === 'read' ? { trips: [] } : success());
  expect(await result).toMatchObject({ ok: false, reason: 'stale' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
