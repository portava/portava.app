import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { Fiber } from 'test-renderer';

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
jest.mock('../../../lib/supabase.ts', () => ({ ...jest.requireActual('../../../lib/supabase.ts'), isSupabaseConfigured: true }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../ui/KeyboardSafeView.tsx', () => ({
  ...jest.requireActual('../../ui/KeyboardSafeView.tsx'),
  KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));
jest.mock('../../../hooks/usePlaceSearch.ts', () => ({
  ...jest.requireActual('../../../hooks/usePlaceSearch.ts'),
  usePlaceSearch: () => ({ results: [], loading: false, error: null }),
}));
jest.mock('../../../hooks/useGooglePlacesAutocomplete.ts', () => ({
  ...jest.requireActual('../../../hooks/useGooglePlacesAutocomplete.ts'),
  useGooglePlacesAutocomplete: () => ({ places: [], loading: false }),
}));
jest.mock('../../../hooks/usePopularCities.ts', () => ({
  ...jest.requireActual('../../../hooks/usePopularCities.ts'), usePopularCities: () => ({ places: [] }),
}));
jest.mock('../../../platform/input-assistance/hooks/useInputAssistance.ts', () => ({
  ...jest.requireActual('../../../platform/input-assistance/hooks/useInputAssistance.ts'),
  useInputAssistance: () => ({ suggestions: [], policy: null, answeredText: '' }),
}));
jest.mock('expo-location', () => ({
  ...jest.requireActual('expo-location'),
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getLastKnownPositionAsync: jest.fn(async () => null),
}));

import { supabase } from '../../../lib/supabase.ts';
import { GlobalPlacePicker } from '../GlobalPlacePicker.tsx';
import { captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../../services/messagingOwnerRequest.ts';
import { _resetDiscoveryViewerScopeForTests, invalidateDiscoveryCaches, setDiscoveryViewerFromSession, currentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';
import type { Place } from '../../../lib/location/placeTypes.ts';

type AuthControl = { getSession: jest.Mock; refreshSession: jest.Mock; listeners: Set<AuthListener> };
type Props = React.ComponentProps<typeof GlobalPlacePicker>;
type Request = { route: string; method: string; owner: string; sessionId: string; body: { place: Place; usedFor?: string } | null };
const auth = supabase.auth as unknown as AuthControl;
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let currentSession: Session | null;
let requests: Request[];
let unexpected: string[];
let respond: (request: Request) => Response | Promise<Response>;
let serial = 0;
let query: string;

function session(owner = 'owner-a', sessionId = owner + '-session', expired = false): Session {
  return {
    access_token: 'e30.' + btoa(JSON.stringify({ sub: owner, session_id: sessionId })) + '.synthetic',
    refresh_token: 'synthetic', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -1 : 3600),
    user: { id: owner, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-16T00:00:00Z' },
  };
}

function observe(value: Session | null) {
  currentSession = value;
  for (const listener of [...auth.listeners]) listener(value ? 'SIGNED_IN' : 'SIGNED_OUT', value);
  setDiscoveryViewerFromSession(value?.user.id ?? null);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}

function response(body: unknown): Response { return { ok: true, json: async () => body } as Response; }
function resolves() { return requests.filter(request => request.route === '/api/locations/resolve'); }
function recentWrites() { return requests.filter(request => request.route === '/api/me/recent-places' && request.method === 'POST'); }

beforeEach(() => {
  serial += 1;
  query = 'Canonical owner probe ' + serial;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://canonical-picker.test';
  disposeMessagingOwnerObserver();
  _resetDiscoveryViewerScopeForTests();
  initializeMessagingOwnerObserver();
  observe(session());
  auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  auth.refreshSession.mockReset().mockImplementation(async () => ({ data: { session: currentSession } }));
  requests = [];
  unexpected = [];
  respond = request => response({ canonicalId: request.owner + '-canonical', place: { ...request.body!.place, canonicalId: request.owner + '-canonical' } });
  globalThis.fetch = jest.fn(async (destination, init = {}) => {
    const url = new URL(String(destination));
    if (url.origin !== 'http://canonical-picker.test' || !['/api/locations/resolve', '/api/me/recent-places'].includes(url.pathname)) {
      unexpected.push(String(destination));
      throw new Error('External network forbidden');
    }
    const token = (init.headers as Record<string, string>).Authorization.slice(7);
    const claims = JSON.parse(atob(token.split('.')[1])) as { sub: string; session_id: string };
    const request = { route: url.pathname, method: init.method ?? 'GET', owner: claims.sub, sessionId: claims.session_id, body: init.body ? JSON.parse(String(init.body)) : null };
    requests.push(request);
    return url.pathname === '/api/locations/resolve' ? respond(request) : response({ places: [] });
  });
});

afterEach(async () => {
  await cleanup();
  disposeMessagingOwnerObserver();
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  expect(unexpected).toEqual([]);
});

async function mount() {
  const props: Props = { visible: true, allowGPS: false, usedFor: 'event_location', placeholder: 'Owner transport query', onSelect: jest.fn(), onCanonicalBinding: jest.fn(), onClose: jest.fn() };
  const mounted = await render(<GlobalPlacePicker {...props} />);
  if (currentSession) await waitFor(() => expect(requests.some(request => request.route === '/api/me/recent-places')).toBe(true));
  await act(async () => { await Promise.resolve(); });
  return { ...mounted, props };
}

async function selectManual() {
  await fireEvent.changeText(screen.getByPlaceholderText('Owner transport query'), query);
  const row = screen.getByText('Add as custom location');
  expect(row).toBeEnabled();
  let fiber: Fiber | null = row.unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No mounted manual selection handler');
  let work: void | Promise<void>;
  await act(async () => { work = fiber!.memoizedProps.onPress(); });
  return { finish: async () => { await act(async () => { await work; }); } };
}

function revoke(boundary: 'account' | 'privacy' | 'round-trip') {
  if (boundary === 'account') observe(session('owner-b'));
  else if (boundary === 'privacy') invalidateDiscoveryCaches();
  else { observe(null); observe(session()); }
}

describe('actual picker to canonical resolver transport ownership', () => {
  const waits = (['account', 'privacy', 'round-trip'] as const)
    .flatMap(boundary => (['getSession', 'refreshSession'] as const).map(stage => [boundary, stage] as const));

  test.each(waits)('mounted %s during %s prevents resolver POST, not just downstream selection', async (boundary, stage) => {
    const mounted = await mount();
    expect(captureMessagingOwnerRequest()?.isCurrent()).toBe(true);
    const pending = deferred<{ data: { session: Session | null } }>();
    if (stage === 'getSession') auth.getSession.mockReturnValueOnce(pending.promise);
    else {
      auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-a', 'owner-a-session', true) } });
      auth.refreshSession.mockReturnValueOnce(pending.promise);
    }
    const gesture = await selectManual();
    if (stage === 'refreshSession') expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    await act(async () => { revoke(boundary); pending.resolve({ data: { session: currentSession } }); });
    await gesture.finish();
    expect(resolves()).toEqual([]);
    expect(recentWrites()).toEqual([]);
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
    expect(mounted.props.onCanonicalBinding).not.toHaveBeenCalled();
  });

  test.each(['account', 'privacy'] as const)('late JSON after %s cannot poison the next mounted selection cache', async boundary => {
    const pending = deferred<unknown>();
    respond = () => ({ ...response(null), json: () => pending.promise });
    const first = await mount();
    const old = await selectManual();
    await waitFor(() => expect(resolves()).toHaveLength(1));
    const original = resolves()[0].body!.place;
    await act(async () => { revoke(boundary); pending.resolve({ canonicalId: 'retired', place: { ...original, canonicalId: 'retired' } }); });
    await old.finish();
    expect(first.props.onSelect).not.toHaveBeenCalled();
    await first.unmount();
    respond = request => response({ canonicalId: 'current', place: { ...request.body!.place, canonicalId: 'current' } });
    const next = await mount();
    const current = await selectManual();
    await current.finish();
    expect(resolves()).toHaveLength(2);
    expect(next.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ canonicalId: 'current' }));
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].body?.place.canonicalId).toBe('current');
  });

  test('warm Alpha canonical cache does not become Beta selection or recent payload', async () => {
    const first = await mount();
    const initial = await selectManual();
    await initial.finish();
    expect(first.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ canonicalId: 'owner-a-canonical' }));
    await first.unmount();
    observe(session('owner-b'));
    const next = await mount();
    const second = await selectManual();
    await second.finish();
    expect(resolves()).toHaveLength(2);
    expect(resolves()[1].owner).toBe('owner-b');
    expect(next.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ canonicalId: 'owner-b-canonical' }));
    expect(recentWrites().at(-1)).toMatchObject({ owner: 'owner-b', body: { place: { canonicalId: 'owner-b-canonical' } } });
  });

  test('healthy actual selection resolves, saves the exact canonical payload and dispatches once', async () => {
    const mounted = await mount();
    const gesture = await selectManual();
    await gesture.finish();
    expect(resolves()).toHaveLength(1);
    expect(resolves()[0]).toMatchObject({ owner: 'owner-a', body: { place: { name: query } } });
    expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
    expect(mounted.props.onCanonicalBinding).toHaveBeenCalledTimes(1);
    expect(mounted.props.onClose).toHaveBeenCalledTimes(1);
    const selected = jest.mocked(mounted.props.onSelect).mock.calls[0][0];
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].body).toEqual({ place: selected, usedFor: 'event_location' });
  });

  test('observed anonymous selection preserves manual callback and local-only history', async () => {
    observe(null);
    const mounted = await mount();
    const gesture = await selectManual();
    await gesture.finish();
    expect(resolves()).toEqual([]);
    expect(recentWrites()).toEqual([]);
    expect(mounted.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: query, source: 'manual' }));
  });

  test('current token failure preserves manual fallback without invalidating a later same-owner recent save', async () => {
    const mounted = await mount();
    auth.getSession.mockRejectedValueOnce(new Error('Synthetic offline auth'));
    const gesture = await selectManual();
    await gesture.finish();
    expect(resolves()).toEqual([]);
    expect(mounted.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: query, source: 'manual' }));
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].owner).toBe('owner-a');
  });

  test.each(['close', 'unmount'] as const)('%s alone remains caller-owned, not new resolver transport cancellation', async boundary => {
    const mounted = await mount();
    const pending = deferred<{ data: { session: Session | null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    const gesture = await selectManual();
    if (boundary === 'close') await fireEvent.press(screen.getAllByTestId('icon-X')[0]);
    else await mounted.unmount();
    await act(async () => { pending.resolve({ data: { session: currentSession } }); });
    await gesture.finish();
    expect(resolves()).toHaveLength(1);
    expect(resolves()[0].owner).toBe('owner-a');
    expect(recentWrites()).toEqual([]);
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
  });
});

async function drainPicker() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

function currentPoint(): Place {
  return { id: 'session-point-' + serial, type: 'place', name: query, displayName: query, source: 'manual',
    country: null, countryCode: null, region: null, city: null, district: null, lat: 0, lng: 0, timezone: null };
}

async function mountPoint() {
  const point = currentPoint();
  const props: Props = { visible: true, allowGPS: false, usedFor: 'event_location',
    contextSections: [{ label: 'Session-bound choice', places: [point] }],
    onSelect: jest.fn(), onCanonicalBinding: jest.fn(), onClose: jest.fn() };
  const mounted = await render(<GlobalPlacePicker {...props} />);
  await act(drainPicker);
  return { ...mounted, props, point };
}

async function startPoint() {
  let fiber: Fiber | null = screen.getByText(query).unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('No actual point selection handler');
  const handler = fiber.memoizedProps.onPress as () => Promise<void>;
  let work: Promise<void> | undefined;
  await act(async () => { work = handler(); await drainPicker(); });
  return { finish: async () => { await act(async () => { await work; await drainPicker(); }); } };
}

async function pausePoint(stage: 'getSession' | 'refreshSession' | 'headers' | 'json') {
  const pending = deferred<unknown>();
  if (stage === 'getSession') auth.getSession.mockReturnValueOnce(pending.promise);
  else if (stage === 'refreshSession') {
    auth.getSession.mockResolvedValueOnce({ data: { session: session('owner-a', 'owner-a-session', true) } });
    auth.refreshSession.mockReturnValueOnce(pending.promise);
  } else if (stage === 'headers') respond = () => pending.promise as Promise<Response>;
  else respond = () => ({ ...response(null), json: () => pending.promise });
  const gesture = await startPoint();
  if (stage === 'getSession' || stage === 'refreshSession') expect(resolves()).toEqual([]);
  else expect(resolves()).toHaveLength(1);
  return {
    finish: async () => {
      const resolved = { canonicalId: 'current-canonical', place: { ...currentPoint(), canonicalId: 'current-canonical' } };
      await act(async () => {
        pending.resolve(stage === 'getSession' || stage === 'refreshSession' ? { data: { session: currentSession } }
          : stage === 'headers' ? response(resolved) : resolved);
      });
      await gesture.finish();
    },
  };
}

function refreshSameSession() {
  const prior = currentSession!;
  const refreshed = { ...prior, access_token: 'e30.' + btoa(JSON.stringify({ sub: prior.user.id, session_id: 'owner-a-session', version: 'refreshed' })) + '.synthetic' };
  currentSession = refreshed;
  for (const listener of [...auth.listeners]) listener('TOKEN_REFRESHED', refreshed);
  setDiscoveryViewerFromSession(refreshed.user.id);
}

describe('proposed picker original-session contract, actual mounted boundary', () => {
  test.each(['getSession', 'refreshSession', 'headers', 'json'] as const)('RED replacement during %s refuses raw fallback and replacement-session recent write', async stage => {
    const mounted = await mountPoint();
    const scope = currentDiscoveryScope();
    const lease = captureMessagingOwnerRequest()!;
    const gesture = await pausePoint(stage);
    await act(async () => { observe(session('owner-a', 'replacement-session')); });
    expect(currentDiscoveryScope()).toEqual(scope);
    expect(lease.isCurrent()).toBe(false);
    await gesture.finish();
    expect(resolves()).toHaveLength(stage === 'getSession' || stage === 'refreshSession' ? 0 : 1);
    console.log('picker-session-observation', JSON.stringify({ stage,
      select: jest.mocked(mounted.props.onSelect).mock.calls.length,
      binding: jest.mocked(mounted.props.onCanonicalBinding!).mock.calls.length,
      close: jest.mocked(mounted.props.onClose).mock.calls.length,
      recentSessions: recentWrites().map(request => request.sessionId),
      recentCanonical: recentWrites().map(request => request.body?.place.canonicalId ?? null) }));
    expect({ select: jest.mocked(mounted.props.onSelect).mock.calls.length,
      binding: jest.mocked(mounted.props.onCanonicalBinding!).mock.calls.length,
      close: jest.mocked(mounted.props.onClose).mock.calls.length, recentWrites: recentWrites().length })
      .toEqual({ select: 0, binding: 0, close: 0, recentWrites: 0 });
  });

  test.each(['getSession', 'refreshSession', 'headers', 'json'] as const)('CONTROL stable-session token refresh during %s retains the gesture', async stage => {
    const mounted = await mountPoint();
    const scope = currentDiscoveryScope();
    const lease = captureMessagingOwnerRequest()!;
    const observers = auth.listeners.size;
    const gesture = await pausePoint(stage);
    await act(async () => { refreshSameSession(); });
    expect(currentDiscoveryScope()).toEqual(scope);
    expect(lease.isCurrent()).toBe(true);
    await gesture.finish();
    expect(auth.listeners.size).toBe(observers);
    expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
    expect(mounted.props.onCanonicalBinding).toHaveBeenCalledTimes(1);
    expect(mounted.props.onClose).toHaveBeenCalledTimes(1);
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].sessionId).toBe('owner-a-session');
    expect(jest.mocked(mounted.props.onSelect).mock.calls[0][0].canonicalId).toBeTruthy();
  });

  test('RED session ABA cannot revive an old gesture even when the token again names its starting session', async () => {
    const mounted = await mountPoint();
    const lease = captureMessagingOwnerRequest()!;
    const scope = currentDiscoveryScope();
    const gesture = await pausePoint('getSession');
    await act(async () => { observe(session('owner-a', 'replacement-session')); observe(session()); });
    expect(currentDiscoveryScope()).toEqual(scope);
    expect(lease.isCurrent()).toBe(false);
    await gesture.finish();
    expect(resolves()).toEqual([]);
    expect({ selections: jest.mocked(mounted.props.onSelect).mock.calls.length, recents: recentWrites().length }).toEqual({ selections: 0, recents: 0 });
  });

  test.each(['unobserved', 'missing-session', 'malformed', 'unknown-scope'] as const)('missing %s identity must not become a healthy authenticated intent', async invalid => {
    if (invalid === 'unobserved') { disposeMessagingOwnerObserver(); initializeMessagingOwnerObserver(); }
    else if (invalid === 'unknown-scope') _resetDiscoveryViewerScopeForTests();
    else {
      const unreadable = { ...session(), access_token: invalid === 'malformed' ? 'malformed' : 'e30.' + btoa(JSON.stringify({ sub: 'owner-a' })) + '.synthetic' };
      observe(unreadable);
    }
    expect(captureMessagingOwnerRequest()).toBeNull();
    const mounted = await mountPoint();
    const gesture = await startPoint();
    await gesture.finish();
    expect(resolves()).toEqual([]);
    expect(recentWrites()).toEqual([]);
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
    expect(mounted.props.onCanonicalBinding).not.toHaveBeenCalled();
    expect(mounted.props.onClose).not.toHaveBeenCalled();
  });

  test('CONTROL intentionally observed anonymous zero-coordinate selection remains local and callback-capable', async () => {
    observe(null);
    const mounted = await mountPoint();
    const gesture = await startPoint();
    await gesture.finish();
    expect(mounted.props.onSelect).toHaveBeenCalledWith(mounted.point);
    expect(mounted.props.onClose).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
  });

  test('RED reentrant same-owner replacement in canonical binding stops later caller callbacks', async () => {
    const mounted = await mountPoint();
    jest.mocked(mounted.props.onCanonicalBinding!).mockImplementation(() => { observe(session('owner-a', 'replacement-session')); });
    const gesture = await startPoint();
    await gesture.finish();
    expect(mounted.props.onCanonicalBinding).toHaveBeenCalledTimes(1);
    expect(recentWrites()).toEqual([]);
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
    expect(mounted.props.onClose).not.toHaveBeenCalled();
  });

  test.each(['getSession', 'json'] as const)('retired %s completion releases only its own slot for a new explicit selection', async stage => {
    const mounted = await mountPoint();
    const observers = auth.listeners.size;
    const old = await pausePoint(stage);
    await act(async () => { observe(session('owner-a', 'replacement-session')); });
    await old.finish();
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
    expect(mounted.props.onClose).not.toHaveBeenCalled();
    expect(recentWrites()).toEqual([]);
    expect(screen.getByText(query)).toBeEnabled();
    respond = request => response({ canonicalId: 'new-current', place: { ...request.body!.place, canonicalId: 'new-current' } });
    const next = await startPoint();
    await next.finish();
    expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
    expect(mounted.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ canonicalId: 'new-current' }));
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].sessionId).toBe('replacement-session');
    expect(auth.listeners.size).toBe(observers);
  });

  test.each(['getSession', 'json'] as const)('old %s finalizer cannot unlock a newer same-open session selection', async stage => {
    const mounted = await mountPoint();
    const old = await pausePoint(stage);
    await act(async () => { observe(session('owner-a', 'replacement-session')); });
    const pending = deferred<unknown>();
    respond = () => ({ ...response(null), json: () => pending.promise });
    await fireEvent.changeText(screen.getByPlaceholderText('Search cities, hotels, landmarks…'), 'New session explicit submit ' + serial);
    const submit = screen.getByPlaceholderText('Search cities, hotels, landmarks…').props.onSubmitEditing;
    await act(async () => { submit(); await drainPicker(); });
    expect(resolves()).toHaveLength(stage === 'json' ? 2 : 1);
    await old.finish();
    expect(screen.getByText('Add as custom location')).toBeDisabled();
    await fireEvent.press(screen.getByText('Add as custom location'));
    expect(resolves()).toHaveLength(stage === 'json' ? 2 : 1);
    expect(mounted.props.onSelect).not.toHaveBeenCalled();
    expect(recentWrites()).toEqual([]);
    await act(async () => {
      pending.resolve({ canonicalId: 'successor-canonical', place: { ...resolves().at(-1)!.body!.place, canonicalId: 'successor-canonical' } });
      await drainPicker();
    });
    expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
    expect(mounted.props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ canonicalId: 'successor-canonical' }));
    expect(recentWrites()).toHaveLength(1);
    expect(recentWrites()[0].sessionId).toBe('replacement-session');
  });
});
