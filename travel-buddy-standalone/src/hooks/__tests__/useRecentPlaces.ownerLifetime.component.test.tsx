import React from 'react';
import { Text } from 'react-native';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { Session, AuthChangeEvent } from '@supabase/supabase-js';

type AuthCallback = (event: AuthChangeEvent, value: Session | null) => void;

jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<AuthCallback>();
  const auth = {
    getSession: jest.fn(),
    refreshSession: jest.fn(),
    onAuthStateChange: jest.fn((callback: AuthCallback) => {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    }),
    listeners,
  };
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: jest.fn(() => ({ auth })) };
});

jest.mock('../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

import { supabase } from '../../lib/supabase.ts';
import { useRecentPlaces } from '../useRecentPlaces.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import { captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../services/messagingOwnerRequest.ts';
import { _resetDiscoveryViewerScopeForTests, openDiscoveryLease, currentDiscoveryScope, invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

type AuthControl = {
  getSession: jest.Mock;
  refreshSession: jest.Mock;
  listeners: Set<(event: AuthChangeEvent, value: Session | null) => void>;
};
type Call = { method: string; owner: string; sessionId: string; body: unknown };
const auth = supabase.auth as unknown as AuthControl;
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let currentSession: Session | null;
let calls: Call[];
let respond: (call: Call) => Promise<Response> | Response;

function session(owner = 'owner-a', sessionId = owner + '-session', expired = false): Session {
  return {
    access_token: 'e30.' + btoa(JSON.stringify({ sub: owner, session_id: sessionId })) + '.synthetic',
    refresh_token: 'synthetic',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600),
    user: { id: owner, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-16T00:00:00Z' },
  };
}

function emit(event: AuthChangeEvent, value: Session | null, updateScope = true) {
  currentSession = value;
  if (updateScope) setDiscoveryViewerFromSession(value?.user.id ?? null);
  for (const listener of [...auth.listeners]) listener(event, value);
}

function place(id = 'private-a'): Place {
  return {
    id, name: id, displayName: id, type: 'place', source: 'manual', country: null,
    countryCode: null, region: null, city: 'Private city ' + id, district: null,
    lat: 1.25, lng: 2.5, timezone: null,
  };
}

function response(places: Place[] = [], status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ places }) } as Response;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

function writes() { return calls.filter(call => call.method === 'POST'); }
function evidence() {
  return writes().map(call => ({ owner: call.owner, sessionId: call.sessionId, place: (call.body as { place: Place }).place.id }));
}

async function ready() {
  const mounted = await renderHook(() => useRecentPlaces());
  await waitFor(() => expect(mounted.result.current.loading).toBe(false));
  return mounted;
}

function CacheReader({ observations }: { observations?: string[][] }) {
  const { recents } = useRecentPlaces();
  observations?.push(recents.map(item => item.id));
  return <Text testID="recent-names">{recents.map(item => item.id).join('|')}</Text>;
}

async function initialize(anonymous = false) {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://recent.test';
  disposeMessagingOwnerObserver();
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession(anonymous ? null : 'owner-a');
  currentSession = anonymous ? null : session();
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  initializeMessagingOwnerObserver();
  emit('INITIAL_SESSION', currentSession);
  calls = [];
  respond = () => response();
  globalThis.fetch = jest.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://recent.test' || url.pathname !== '/api/me/recent-places') throw new Error('External network forbidden');
    const bearer = (init.headers as Record<string, string>)?.Authorization?.slice('Bearer '.length);
    const identity = JSON.parse(atob(bearer.split('.')[1])) as { sub: string; session_id: string };
    const call = { method: init.method ?? 'GET', owner: identity.sub, sessionId: identity.session_id, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call);
  });
  const reset = await ready();
  await reset.unmount();
  calls = [];
}

afterEach(async () => {
  await cleanup();
  disposeMessagingOwnerObserver();
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

test('observed initial null supports local history without a provider default or remote request', async () => {
  await initialize(true);
  const mounted = await ready();
  await act(async () => { await mounted.result.current.saveRecent(place('initial-anonymous')); });
  expect(calls).toEqual([]);
  expect(mounted.result.current.recents.map(item => item.id)).toEqual(['initial-anonymous']);
});

describe('observed owner lifetimes', () => {
  beforeEach(() => initialize());

  test.each(['account', 'privacy', 'same-owner-new-session'] as const)('boundary: valid save invocation cannot dispatch after %s changes during getSession', async boundary => {
    const mounted = await ready();
    const owner = captureMessagingOwnerRequest();
    expect(owner?.isCurrent()).toBe(true);
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = mounted.result.current.saveRecent(place(), 'event_location'); });
    expect(writes()).toHaveLength(0);
    await act(async () => {
      if (boundary === 'account') emit('SIGNED_IN', session('owner-b'));
      else if (boundary === 'privacy') invalidateDiscoveryCaches();
      else emit('SIGNED_IN', session('owner-a', 'replacement-session'));
      expect(owner?.isCurrent()).toBe(false);
      pending.resolve({ data: { session: currentSession } });
      await saving;
    });
    expect(evidence()).toEqual([]);
  });

  test('boundary: real refresh-first token helper cannot move a valid A save to B', async () => {
    const mounted = await ready();
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-a', 'owner-a-session', true) } });
    auth.refreshSession.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = mounted.result.current.saveRecent(place(), 'event_location'); });
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    await act(async () => { emit('SIGNED_IN', session('owner-b')); pending.resolve({ data: { session: currentSession } }); await saving; });
    expect(evidence()).toEqual([]);
  });

  test.each(['known-anonymous', 'unknown'] as const)('boundary: %s save must not adopt a later signed-in owner', async original => {
    const mounted = await ready();
    await act(async () => {
      emit('SIGNED_OUT', null);
      if (original === 'unknown') _resetDiscoveryViewerScopeForTests();
    });
    expect(currentDiscoveryScope().viewer).toBe(original === 'unknown' ? undefined : 'anon');
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = mounted.result.current.saveRecent(place(original)); });
    await act(async () => { emit('SIGNED_IN', session('owner-b')); pending.resolve({ data: { session: currentSession } }); await saving; });
    expect(evidence()).toEqual([]);
  });

  test.each(['account', 'privacy', 'signout'] as const)('boundary: mounted recent view cannot retain A server cache after %s', async boundary => {
    respond = () => response([place('server-private-a')]);
    await render(<CacheReader />);
    await screen.findByText('server-private-a');
    await act(async () => {
      if (boundary === 'account') emit('SIGNED_IN', session('owner-b'));
      else if (boundary === 'signout') emit('SIGNED_OUT', null);
      else invalidateDiscoveryCaches();
    });
    expect(screen.queryByText('server-private-a')).toBeNull();
  });

  test('boundary: B first render cannot paint A cache even if B GET later succeeds empty', async () => {
    respond = () => response([place('server-private-a')]);
    const first = await ready();
    await first.unmount();
    emit('SIGNED_IN', session('owner-b'));
    const pending = deferred<Response>();
    respond = () => pending.promise;
    const observations: string[][] = [];
    await render(<CacheReader observations={observations} />);
    await act(async () => { pending.resolve(response()); });
    expect(observations.some(ids => ids.includes('server-private-a'))).toBe(false);
  });

  test('boundary: B cannot inherit an optimistic A selection while its token acquisition is pending', async () => {
    const first = await ready();
    const token = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(token.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = first.result.current.saveRecent(place('optimistic-private-a')); });
    await first.unmount();
    emit('SIGNED_IN', session('owner-b'));
    respond = () => response([], 503);
    await render(<CacheReader />);
    await act(async () => { token.resolve({ data: { session: null } }); auth.refreshSession.mockResolvedValueOnce({ data: { session: null } }); await saving; });
    expect(screen.queryByText('optimistic-private-a')).toBeNull();
  });

  test.each(['account', 'privacy', 'unmount'] as const)('boundary: late A response.json cannot repopulate cache after %s', async boundary => {
    const body = deferred<unknown>();
    let bodyStarted = false;
    respond = () => ({ ...response(), json: () => { bodyStarted = true; return body.promise; } } as Response);
    const first = await renderHook(() => useRecentPlaces());
    await waitFor(() => expect(bodyStarted).toBe(true));
    expect(calls[0].owner).toBe('owner-a');
    if (boundary === 'unmount') await first.unmount();
    else await act(async () => {
      if (boundary === 'account') emit('SIGNED_IN', session('owner-b'));
      else invalidateDiscoveryCaches();
    });
    respond = () => response([place('current-safe')]);
    const current = await ready();
    expect(current.result.current.recents.map(item => item.id)).toEqual(['current-safe']);
    await act(async () => { body.resolve({ places: [place('late-private-a')] }); });
    respond = () => response([], 503);
    await render(<CacheReader />);
    expect(screen.queryByText('late-private-a')).toBeNull();
  });

  test('control: valid A save uses A bearer and retains exact place and usedFor', async () => {
    const mounted = await ready();
    const selected = place();
    await act(async () => { await mounted.result.current.saveRecent(selected, 'event_location'); });
    expect(writes()).toEqual([{ method: 'POST', owner: 'owner-a', sessionId: 'owner-a-session', body: { place: selected, usedFor: 'event_location' } }]);
    expect(mounted.result.current.recents).toEqual([selected]);
  });

  test('control: unchanged same-owner scope notification preserves valid pending save', async () => {
    const mounted = await ready();
    const owner = captureMessagingOwnerRequest()!;
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = mounted.result.current.saveRecent(place()); });
    await act(async () => { emit('TOKEN_REFRESHED', session()); expect(owner.isCurrent()).toBe(true); pending.resolve({ data: { session: currentSession } }); await saving; });
    expect(evidence()).toEqual([{ owner: 'owner-a', sessionId: 'owner-a-session', place: 'private-a' }]);
  });

  test('control: known anonymous selection remains local with no POST when auth stays absent', async () => {
    emit('SIGNED_OUT', null);
    const mounted = await ready();
    await act(async () => { await mounted.result.current.saveRecent(place('anonymous-choice')); });
    expect(writes()).toEqual([]);
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['anonymous-choice']);
  });

  test('control: transient signed-in token failure keeps own optimistic fallback without POST', async () => {
    const mounted = await ready();
    auth.getSession.mockRejectedValueOnce(new Error('Synthetic unavailable session'));
    await act(async () => { await mounted.result.current.saveRecent(place('own-offline')); });
    expect(writes()).toEqual([]);
    expect(currentDiscoveryScope().viewer).toBe('u:owner-a');
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['own-offline']);
  });

  test('control: same-owner remount uses fallback on HTTP failure and genuine empty later clears it', async () => {
    respond = () => response([place('own-stored')]);
    const first = await ready();
    await first.unmount();
    respond = () => response([], 503);
    const next = await ready();
    expect(next.result.current.recents.map(item => item.id)).toEqual(['own-stored']);
    respond = () => response([]);
    await act(async () => { await next.result.current.reload(); });
    expect(next.result.current.recents).toEqual([]);
  });

  test('control: local recents keep existing ten-item cap and deduplicate by id', async () => {
    const mounted = await ready();
    for (let index = 0; index < 12; index += 1) {
      await act(async () => { await mounted.result.current.saveRecent(place('recent-' + index)); });
    }
    await act(async () => { await mounted.result.current.saveRecent(place('recent-7')); });
    expect(mounted.result.current.recents).toHaveLength(10);
    expect(mounted.result.current.recents[0].id).toBe('recent-7');
    expect(mounted.result.current.recents.filter(item => item.id === 'recent-7')).toHaveLength(1);
  });


  test('unknown startup waits for an auth observation and never replays its earlier save', async () => {
    disposeMessagingOwnerObserver();
    _resetDiscoveryViewerScopeForTests();
    initializeMessagingOwnerObserver();
    const mounted = await ready();
    expect(calls).toEqual([]);
    await act(async () => { await mounted.result.current.saveRecent(place('unknown-choice')); });
    expect(mounted.result.current.recents).toEqual([]);
    await act(async () => { emit('SIGNED_IN', session('owner-b')); });
    await waitFor(() => expect(calls.filter(call => call.method === 'GET')).toHaveLength(1));
    expect(writes()).toEqual([]);
    expect(mounted.result.current.recents).toEqual([]);
  });

  test('anonymous discovery transport fallback is not an observed signout', async () => {
    const mounted = await ready();
    await act(async () => { openDiscoveryLease(null); });
    expect(currentDiscoveryScope().viewer).toBe('anon');
    await act(async () => { await mounted.result.current.saveRecent(place('must-not-be-anonymous')); });
    expect(mounted.result.current.recents).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test('late INITIAL_SESSION null cannot turn an established signed-in account into anonymous history', async () => {
    const mounted = await ready();
    await act(async () => {
      openDiscoveryLease(null);
      for (const listener of [...auth.listeners]) listener('INITIAL_SESSION', null);
      await mounted.result.current.saveRecent(place('late-initial'));
    });
    expect(mounted.result.current.recents).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test('confirmed anonymous history survives remount but never crosses into an account', async () => {
    emit('SIGNED_OUT', null);
    const first = await ready();
    await act(async () => { await first.result.current.saveRecent(place('anonymous-local')); });
    await first.unmount();
    const next = await ready();
    expect(next.result.current.recents.map(item => item.id)).toEqual(['anonymous-local']);
    expect(calls).toEqual([]);
    await act(async () => { emit('SIGNED_IN', session('owner-b')); });
    expect(next.result.current.recents).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test('captured callbacks after unmount neither fetch nor update the shared cache', async () => {
    const mounted = await ready();
    const oldSave = mounted.result.current.saveRecent;
    const oldReload = mounted.result.current.reload;
    await mounted.unmount();
    const before = calls.length;
    await act(async () => { await oldSave(place('unmounted')); await oldReload(); });
    expect(calls).toHaveLength(before);
    respond = () => response([], 503);
    const next = await ready();
    expect(next.result.current.recents).toEqual([]);
  });

  test.each(['account', 'privacy', 'observer-disposal', 'round-trip', 'reused-session'] as const)('read token continuation is fenced after %s', async boundary => {
    const mounted = await ready();
    const before = calls.length;
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    let reading!: Promise<void>;
    await act(async () => { reading = mounted.result.current.reload(); });
    await act(async () => {
      if (boundary === 'account') emit('SIGNED_IN', session('owner-b'));
      else if (boundary === 'privacy') invalidateDiscoveryCaches();
      else if (boundary === 'observer-disposal') { disposeMessagingOwnerObserver(); initializeMessagingOwnerObserver(); emit('INITIAL_SESSION', session()); }
      else if (boundary === 'round-trip') { emit('SIGNED_IN', session('owner-b')); emit('SIGNED_IN', session()); }
      else { emit('SIGNED_OUT', null); emit('SIGNED_IN', session()); }
      pending.resolve({ data: { session: currentSession } });
      await reading;
    });
    expect(calls).toHaveLength(before);
  });

  test('late HTTP headers do not start body parsing or refill a changed owner cache', async () => {
    const pending = deferred<Response>();
    const readBody = jest.fn(async () => ({ places: [place('old-response')] }));
    respond = () => pending.promise;
    const old = await renderHook(() => useRecentPlaces());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => { emit('SIGNED_IN', session('owner-b')); });
    respond = () => response([place('new-response')]);
    const next = await ready();
    await act(async () => { pending.resolve({ ...response(), json: readBody }); });
    expect(readBody).not.toHaveBeenCalled();
    expect(next.result.current.recents.map(item => item.id)).toEqual(['new-response']);
    await old.unmount();
  });

  test('older reload cannot settle newer loading or replace its result', async () => {
    const mounted = await ready();
    const older = deferred<Response>();
    const newer = deferred<Response>();
    let count = 0;
    respond = () => ++count === 1 ? older.promise : newer.promise;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = mounted.result.current.reload(); });
    await act(async () => { second = mounted.result.current.reload(); });
    await act(async () => { older.resolve(response([place('old')])); await first; });
    expect(mounted.result.current.loading).toBe(true);
    await act(async () => { newer.resolve(response([place('new')])); await second; });
    expect(mounted.result.current.loading).toBe(false);
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['new']);
  });

  test('a late read cannot erase a newer optimistic selection', async () => {
    const mounted = await ready();
    const pending = deferred<Response>();
    respond = call => call.method === 'GET' ? pending.promise : response();
    let reading!: Promise<void>;
    await act(async () => { reading = mounted.result.current.reload(); });
    await act(async () => { await mounted.result.current.saveRecent(place('new-choice')); });
    await act(async () => { pending.resolve(response([])); await reading; });
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['new-choice']);
  });

  test('all mounted consumers share an optimistic update and clear on same-owner session replacement', async () => {
    const first = await ready();
    const second = await ready();
    await act(async () => { await first.result.current.saveRecent(place('shared-current')); });
    expect(second.result.current.recents.map(item => item.id)).toEqual(['shared-current']);
    await act(async () => { emit('SIGNED_IN', session('owner-a', 'new-session')); });
    expect(first.result.current.recents).toEqual([]);
    expect(second.result.current.recents).toEqual([]);
  });

  test.each(['throw', 'null', 'wrong-owner', 'wrong-session'] as const)('token attempt %s does not poison retained same-owner cache provenance', async failure => {
    const mounted = await ready();
    if (failure === 'throw') auth.getSession.mockRejectedValueOnce(new Error('Temporary failure'));
    else if (failure === 'null') {
      auth.getSession.mockResolvedValueOnce({ data: { session: null } });
      auth.refreshSession.mockResolvedValueOnce({ data: { session: null } });
    } else auth.getSession.mockResolvedValueOnce({ data: { session: failure === 'wrong-owner' ? session('owner-b') : session('owner-a', 'different-session') } });
    await act(async () => { await mounted.result.current.saveRecent(place('offline-choice')); });
    expect(writes()).toEqual([]);
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['offline-choice']);
    await mounted.unmount();
    respond = () => response([], 503);
    const next = await ready();
    expect(next.result.current.recents.map(item => item.id)).toEqual(['offline-choice']);
    respond = () => response();
    await act(async () => { await next.result.current.saveRecent(place('later-choice')); });
    expect(evidence()).toEqual([{ owner: 'owner-a', sessionId: 'owner-a-session', place: 'later-choice' }]);
  });

  test('an already-dispatched A POST remains A and its late result cannot restore cache after B', async () => {
    const mounted = await ready();
    const pending = deferred<Response>();
    respond = call => call.method === 'POST' ? pending.promise : response();
    let saving!: Promise<void>;
    await act(async () => { saving = mounted.result.current.saveRecent(place('sent-a')); });
    expect(evidence()).toEqual([{ owner: 'owner-a', sessionId: 'owner-a-session', place: 'sent-a' }]);
    await act(async () => { emit('SIGNED_IN', session('owner-b')); pending.resolve(response()); await saving; });
    expect(mounted.result.current.recents).toEqual([]);
    expect(writes()).toHaveLength(1);
  });

  test('same-session refresh preserves warm cache without launching another read', async () => {
    respond = () => response([place('warm')]);
    const mounted = await ready();
    const count = calls.length;
    await act(async () => { emit('TOKEN_REFRESHED', session()); });
    expect(mounted.result.current.recents.map(item => item.id)).toEqual(['warm']);
    expect(calls).toHaveLength(count);
  });

  test('mount cycles do not accumulate auth listeners', async () => {
    const count = auth.listeners.size;
    for (let index = 0; index < 4; index += 1) {
      const mounted = await ready();
      await mounted.unmount();
    }
    expect(auth.listeners.size).toBe(count);
  });
});

