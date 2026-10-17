import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<AuthListener>();
  const auth = {
    getSession: jest.fn(), refreshSession: jest.fn(), listeners,
    onAuthStateChange: jest.fn((listener: AuthListener) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
  };
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: jest.fn(() => ({ auth })) };
});
jest.mock('../../supabase.ts', () => ({ ...jest.requireActual('../../supabase.ts'), isSupabaseConfigured: true }));

import { supabase } from '../../supabase.ts';
import { resolveCanonicalPlace } from '../resolveCanonical.ts';
import type { Place } from '../placeTypes.ts';
import { captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../../services/messagingOwnerRequest.ts';
import { _resetDiscoveryViewerScopeForTests, currentDiscoveryScope, invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';

type AuthControl = { getSession: jest.Mock; refreshSession: jest.Mock; listeners: Set<AuthListener> };
type Request = { owner: string; sessionId: string; body: { place: Place }; signal: AbortSignal; method: string | undefined };
const auth = supabase.auth as unknown as AuthControl;
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let currentSession: Session | null;
let requests: Request[];
let unexpected: string[];
let respond: (request: Request) => Response | Promise<Response>;
let serial = 0;
let input: Place;

function session(owner = 'owner-a', sessionId = owner + '-session', expired = false): Session {
  return {
    access_token: 'e30.' + btoa(JSON.stringify({ sub: owner, session_id: sessionId })) + '.synthetic',
    refresh_token: 'synthetic', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -1 : 3600),
    user: { id: owner, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-16T00:00:00Z' },
  };
}

function observe(value: Session | null, event: AuthChangeEvent = value ? 'SIGNED_IN' : 'SIGNED_OUT') {
  currentSession = value;
  for (const listener of [...auth.listeners]) listener(event, value);
  setDiscoveryViewerFromSession(value?.user.id ?? null);
}

function place(id: string): Place {
  return { id, name: id, displayName: id, type: 'place', source: 'manual', country: null, countryCode: null, region: null, city: null, district: null, lat: 0, lng: 0, timezone: null };
}

function response(value: Place, canonicalId = 'canonical-' + value.id): Response {
  return { ok: true, json: async () => ({ canonicalId, place: { ...value, canonicalId } }) } as Response;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

type Boundary = 'account' | 'session' | 'privacy' | 'round-trip' | 'observer';
function revoke(boundary: Boundary) {
  if (boundary === 'account') observe(session('owner-b'));
  else if (boundary === 'session') observe(session('owner-a', 'replacement-session'));
  else if (boundary === 'privacy') invalidateDiscoveryCaches();
  else if (boundary === 'round-trip') { observe(null); observe(session()); }
  else { disposeMessagingOwnerObserver(); initializeMessagingOwnerObserver(); observe(session(), 'INITIAL_SESSION'); }
}

beforeEach(() => {
  serial += 1;
  input = place('resolver-' + serial);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://canonical.test';
  disposeMessagingOwnerObserver();
  _resetDiscoveryViewerScopeForTests();
  initializeMessagingOwnerObserver();
  observe(session());
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  requests = [];
  unexpected = [];
  respond = request => response(request.body.place);
  globalThis.fetch = jest.fn(async (destination, init = {}) => {
    if (String(destination) !== 'http://canonical.test/api/locations/resolve') {
      unexpected.push(String(destination));
      throw new Error('External network forbidden');
    }
    const headers = init.headers as Record<string, string>;
    const claims = JSON.parse(atob(headers.Authorization.slice(7).split('.')[1])) as { sub: string; session_id: string };
    expect(headers['Content-Type']).toBe('application/json');
    const request = { owner: claims.sub, sessionId: claims.session_id, body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal, method: init.method };
    requests.push(request);
    return respond(request);
  });
});

afterEach(() => {
  disposeMessagingOwnerObserver();
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  jest.useRealTimers();
  expect(unexpected).toEqual([]);
});

describe('canonical resolution uses the invocation owner and cache lifetime', () => {
  const waits = (['account', 'session', 'privacy', 'round-trip', 'observer'] as const)
    .flatMap(boundary => (['getSession', 'refreshSession'] as const).map(stage => [boundary, stage] as const));

  test.each(waits)('%s during real %s refuses the old POST', async (boundary, stage) => {
    const pending = deferred<{ data: { session: Session | null } }>();
    if (stage === 'getSession') auth.getSession.mockReturnValueOnce(pending.promise);
    else {
      auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-a', 'owner-a-session', true) } });
      auth.refreshSession.mockReturnValueOnce(pending.promise);
    }
    const original = captureMessagingOwnerRequest()!;
    const resolving = resolveCanonicalPlace(input);
    await settle();
    expect(auth[stage]).toHaveBeenCalledTimes(1);
    revoke(boundary);
    expect(original.isCurrent()).toBe(false);
    pending.resolve({ data: { session: currentSession } });
    expect(await resolving).toBe(input);
    expect(requests).toEqual([]);
  });

  test.each(['anonymous', 'unobserved', 'mismatched-scope'] as const)('%s cannot adopt a subsequently observed owner', async initial => {
    if (initial === 'anonymous') observe(null);
    else if (initial === 'unobserved') { disposeMessagingOwnerObserver(); initializeMessagingOwnerObserver(); }
    else setDiscoveryViewerFromSession('owner-b');
    expect(captureMessagingOwnerRequest()).toBeNull();
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    const resolving = resolveCanonicalPlace(input);
    observe(session('owner-b'));
    pending.resolve({ data: { session: currentSession } });
    expect(await resolving).toBe(input);
    expect(requests).toEqual([]);
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  test.each(['account', 'session', 'privacy', 'round-trip', 'observer'] as const)('warm cache cannot survive %s', async boundary => {
    const first = await resolveCanonicalPlace(input);
    expect(first.canonicalId).toBe('canonical-' + input.id);
    revoke(boundary);
    respond = request => response({ ...request.body.place, name: 'fresh result' }, 'fresh-canonical');
    const next = await resolveCanonicalPlace(input);
    expect(requests).toHaveLength(2);
    expect(next).toMatchObject({ name: 'fresh result', canonicalId: 'fresh-canonical' });
    expect(next).not.toBe(first);
  });

  test('revoked authenticated cache is unavailable to an observed anonymous caller', async () => {
    await resolveCanonicalPlace(input);
    observe(null);
    expect(await resolveCanonicalPlace(input)).toBe(input);
    expect(requests).toHaveLength(1);
  });

  const responseWaits = (['account', 'session', 'privacy'] as const)
    .flatMap(boundary => (['headers', 'json'] as const).map(stage => [boundary, stage] as const));

  test.each(responseWaits)('%s during %s refuses old results and cache publication', async (boundary, stage) => {
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    const parse = jest.fn(() => body.promise);
    respond = () => stage === 'headers' ? headers.promise : { ...response(input), json: parse };
    const old = resolveCanonicalPlace(input);
    await settle();
    expect(requests).toHaveLength(1);
    if (stage === 'json') expect(parse).toHaveBeenCalledTimes(1);
    revoke(boundary);
    respond = request => response(request.body.place, 'replacement');
    const replacement = await resolveCanonicalPlace(input);
    expect(replacement.canonicalId).toBe('replacement');
    headers.resolve({ ...response(input), json: parse });
    body.resolve({ canonicalId: 'retired', place: { ...input, canonicalId: 'retired' } });
    expect(await old).toBe(input);
    expect(await resolveCanonicalPlace(input)).toBe(replacement);
    expect(requests).toHaveLength(2);
    if (stage === 'headers') expect(parse).not.toHaveBeenCalled();
  });

  test.each(['null', 'throw', 'wrong-owner', 'wrong-session'] as const)('token %s refuses POST but preserves an unrelated current-owner cache lease', async failure => {
    const warm = await resolveCanonicalPlace(input);
    if (failure === 'throw') auth.getSession.mockRejectedValueOnce(new Error('Offline'));
    else if (failure === 'null') {
      auth.getSession.mockResolvedValueOnce({ data: { session: null } });
      auth.refreshSession.mockResolvedValueOnce({ data: { session: null } });
    } else auth.getSession.mockResolvedValueOnce({ data: { session: failure === 'wrong-owner' ? session('owner-b') : session('owner-a', 'unobserved-session') } });
    const other = place(input.id + '-other');
    expect(await resolveCanonicalPlace(other)).toBe(other);
    expect(requests).toHaveLength(1);
    expect(await resolveCanonicalPlace(input)).toBe(warm);
    expect(captureMessagingOwnerRequest()?.isCurrent()).toBe(true);
    expect(currentDiscoveryScope().viewer).toBe('u:owner-a');
  });

  test('healthy same-owner cache avoids repeat transport and preserves exact input and zero coordinates', async () => {
    const resolved = await resolveCanonicalPlace(input);
    expect(resolved).toEqual({ ...input, canonicalId: 'canonical-' + input.id });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', owner: 'owner-a', sessionId: 'owner-a-session', body: { place: input } });
    expect(await resolveCanonicalPlace({ ...input, displayName: 'same id' })).toBe(resolved);
    expect(requests).toHaveLength(1);
    expect(auth.getSession).toHaveBeenCalledTimes(1);
  });

  test('same-session refresh retains the current request and cache', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-a', 'owner-a-session', true) } });
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.refreshSession.mockReturnValueOnce(pending.promise);
    const resolving = resolveCanonicalPlace(input);
    await settle();
    observe(session(), 'TOKEN_REFRESHED');
    pending.resolve({ data: { session: currentSession } });
    const result = await resolving;
    expect(result.canonicalId).toBe('canonical-' + input.id);
    expect(requests).toHaveLength(1);
    expect(await resolveCanonicalPlace(input)).toBe(result);
  });

  test('caller-provided canonical data remains a pass-through even while anonymous', async () => {
    observe(null);
    const canonical = { ...input, canonicalId: 'already-known' };
    expect(await resolveCanonicalPlace(canonical)).toBe(canonical);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  test.each(['http', 'network', 'json', 'missing-place', 'missing-id', 'no-canonical'] as const)('%s preserves legacy fallback or uncached result behavior', async failure => {
    respond = () => {
      if (failure === 'network') throw new Error('Offline');
      if (failure === 'http') return { ...response(input), ok: false };
      if (failure === 'json') return { ...response(input), json: async () => { throw new Error('Malformed JSON'); } };
      if (failure === 'missing-place') return { ...response(input), json: async () => ({ canonicalId: 'unused' }) };
      if (failure === 'missing-id') return { ...response(input), json: async () => ({ canonicalId: 'unused', place: {} }) };
      return { ...response(input), json: async () => ({ place: input, canonicalId: null }) };
    };
    expect(await resolveCanonicalPlace(input)).toBe(input);
    respond = request => response(request.body.place);
    expect((await resolveCanonicalPlace(input)).canonicalId).toBe('canonical-' + input.id);
    expect(requests).toHaveLength(2);
  });

  test('timeout abort still refuses an uncooperative late response without caching it', async () => {
    jest.useFakeTimers();
    const pending = deferred<Response>();
    respond = () => pending.promise;
    const resolving = resolveCanonicalPlace(input, { timeoutMs: 30 });
    await settle();
    expect(requests).toHaveLength(1);
    jest.advanceTimersByTime(30);
    expect(requests[0].signal.aborted).toBe(true);
    pending.resolve(response(input));
    expect(await resolving).toBe(input);
    expect(jest.getTimerCount()).toBe(0);
    respond = request => response(request.body.place);
    await resolveCanonicalPlace(input);
    expect(requests).toHaveLength(2);
  });
});
