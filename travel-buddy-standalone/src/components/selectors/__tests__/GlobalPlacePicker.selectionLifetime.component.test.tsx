import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import CreateEventScreen from '../../../../app/events/create/index.tsx';
import { GlobalPlacePicker } from '../GlobalPlacePicker.tsx';
import { Alert } from 'react-native';
import * as ExpoLocation from 'expo-location';
import { setDiscoveryViewerFromSession as setViewerScope, invalidateDiscoveryCaches } from '../../../services/discoveryViewerScope.ts';
import { _seedPolicyForTests } from '../../../platform/input-assistance/services/policyStore.ts';
import { registerGeographicFields } from '../../../platform/input-assistance/geographic/geoFields.ts';
import { sharedSuggestionCache, SuggestionCache, inputSessionScopeKey } from '../../../platform/input-assistance/services/suggestionCache.ts';
import { _resetDiscoveryViewerScopeForTests } from '../../../services/discoveryViewerScope.ts';
import { fetchGooglePlaceDetails } from '../../../hooks/useGooglePlacesAutocomplete.ts';
import * as selectionRecorder from '../../../platform/input-assistance/services/selectionRecorder.ts';
import * as prefetch from '../../../platform/input-assistance/services/prefetch.ts';
import type { Place } from '../../../lib/location/placeTypes.ts';
import type { Fiber } from 'test-renderer';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

let mockOwner: string | null = 'owner-a';
let mockSessionGeneration = 0;
type MockAuthListener = (event: AuthChangeEvent, session: Session | null) => void;
var mockAuthListeners: Set<MockAuthListener> | undefined; // eslint-disable-line no-var -- jest hoists the jest.mock factory above this line and it initialises the set; a `let` would still be in its TDZ there
const token = (owner = mockOwner) => owner ? `header.${btoa(JSON.stringify({ sub: owner, session_id: `picker-session-${owner}-${mockSessionGeneration}` }))}.signature` : null;
function mockSession(owner = mockOwner): Session | null {
  if (!owner) return null;
  return {
    access_token: token(owner)!, refresh_token: 'synthetic-refresh-token', token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T00:00:00Z' },
  };
}
function setDiscoveryViewerFromSession(owner: string | null | undefined) {
  const session = mockSession(owner ?? null);
  for (const listener of mockAuthListeners ?? []) listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
  setViewerScope(owner);
}
let mockDraft = {};
let mockParams = { draftId: 'existing-draft' };
let mockLegacy = false;
let mockGooglePlaces: Place[] = [];
const mockPlace = {
  id: 'legacy-venue', type: 'place', name: 'Legacy Venue', displayName: 'Legacy Venue, Da Nang',
  city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', canonicalId: 'legacy-venue',
  lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh', source: 'canonical',
};
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams, usePathname: () => '/events/create',
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
/** NOTE: the auth SDK is isolated to avoid its native storage and live auto-refresh timers. */
jest.mock('../../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true, authedClient: () => null,
  supabase: { auth: {
    getSession: async () => ({ data: { session: mockSession() } }),
    refreshSession: async () => ({ data: { session: mockSession() } }),
    onAuthStateChange: (listener: MockAuthListener) => {
      const listeners = mockAuthListeners ??= new Set<MockAuthListener>();
      listeners.add(listener);
      void Promise.resolve().then(() => { if (listeners.has(listener)) listener('INITIAL_SESSION', mockSession()); });
      return { data: { subscription: { unsubscribe: () => { listeners.delete(listener); } } } };
    },
  } },
}));
jest.mock('../../../components/ui/KeyboardSafeView.tsx', () => ({
  ...jest.requireActual('../../../components/ui/KeyboardSafeView.tsx'),
  KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native'); return <View>{children}</View>;
  },
}));
jest.mock('../../../hooks/usePlaceSearch.ts', () => ({
  ...jest.requireActual('../../../hooks/usePlaceSearch.ts'),
  usePlaceSearch: (text: string) => ({ results: mockLegacy && text ? [mockPlace] : [], loading: false, error: null }),
  fetchPlacesFromApi: jest.fn(),
}));
jest.mock('../../../hooks/useGooglePlacesAutocomplete.ts', () => ({
  ...jest.requireActual('../../../hooks/useGooglePlacesAutocomplete.ts'),
  useGooglePlacesAutocomplete: () => ({ places: mockGooglePlaces, loading: false }), fetchGooglePlaceDetails: jest.fn(),
}));
jest.mock('../../../hooks/usePopularCities.ts', () => ({
  ...jest.requireActual('../../../hooks/usePopularCities.ts'),
  usePopularCities: () => ({ places: [] }),
}));
jest.mock('expo-location', () => ({
  ...jest.requireActual('expo-location'),
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: false })), getLastKnownPositionAsync: jest.fn(async () => null),
  requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(),
}));

const canonicalRow = {
  id: 'event_location:places:11111111-1111-4111-8111-111111111111',
  context: 'event_location', type: 'entity', entityType: 'place', entityId: '11111111-1111-4111-8111-111111111111',
  label: 'Canonical Sky36', subtitle: 'Da Nang', source: 'canonical', confidence: 0.99,
  action: { type: 'open_entity', entityType: 'place', entityId: '11111111-1111-4111-8111-111111111111' },
  structuredValue: {
    entityType: 'venue', venueId: '11111111-1111-4111-8111-111111111111', venue: 'Canonical Sky36',
    cityId: '22222222-2222-4222-8222-222222222222', city: 'Da Nang', country: 'Vietnam', countryCode: 'VN',
    lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh',
  },
  policyVersion: 'test-policy-v1',
};

const fetchMock = jest.fn();
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let served: unknown[] = [];
let unavailable = false;
let holdRequest: ((body: any, init: RequestInit) => Promise<unknown> | undefined) | undefined;
const requests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/input-assistance/suggest'))
  .map(([, init]) => JSON.parse(init.body));
const locationRequests = () => requests().filter(body => body.context === 'event_location');
const writes = () => fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/events/') && init?.method && init.method !== 'GET');
const draftPayload = () => JSON.parse(writes().at(-1)![1].body);
const answer = (suggestions: unknown[]) => ({ ok: true, status: 200, json: async () => ({ suggestions, policyVersion: 'test-policy-v1', schemaVersion: 1 }) });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(accept => { resolve = accept; });
  return { promise, resolve };
};

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  mockLegacy = false;
  mockGooglePlaces = [];
  jest.mocked(fetchGooglePlaceDetails).mockReset();
  jest.mocked(ExpoLocation.getForegroundPermissionsAsync).mockClear();
  jest.mocked(ExpoLocation.getLastKnownPositionAsync).mockClear();
  jest.mocked(ExpoLocation.requestForegroundPermissionsAsync).mockReset();
  jest.mocked(ExpoLocation.getCurrentPositionAsync).mockReset();
  mockOwner = 'owner-a';
  mockSessionGeneration += 1;
  mockParams = { draftId: 'existing-draft' };
  mockDraft = { id: 'existing-draft', title: 'Existing event', description: 'Private event notes', startsAt: '2030-06-07T20:00:00Z', visibility: 'invite_only', circleId: 'private-circle', tripId: 'private-trip' };
  served = [canonicalRow];
  unavailable = false;
  holdRequest = undefined;
  fetchMock.mockReset();
  setDiscoveryViewerFromSession(mockOwner);
  sharedSuggestionCache.clear();
  registerGeographicFields();
  _seedPolicyForTests(['event_title', 'event_location'], {
    event_title: { mode: 'free_text_assisted', allowedSuggestionTypes: ['disambiguation', 'correction'], entityTypes: ['event'], privacyClass: 'public', offlinePolicy: 'unavailable' },
    event_location: { mode: 'canonical_picker', allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'], entityTypes: ['place', 'city'], privacyClass: 'public', offlinePolicy: 'server_required', minChars: 2, debounceMs: 120, zeroStateAssistance: true, allowPersonalization: false, allowLiveContext: true, allowMemoryContext: false, allowAI: false, localSufficient: false },
  });
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/input-assistance/suggest')) {
      const body = JSON.parse(String(init.body ?? '{}'));
      if (body.context === 'event_location') {
        const pending = holdRequest?.(body, init);
        if (pending) return pending;
        if (unavailable) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
        return answer(body.text ? served : []);
      }
      return answer([]);
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && !init.method) {
      return { ok: true, status: 200, json: async () => mockDraft };
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && init.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  });
  global.fetch = fetchMock;
});
afterEach(async () => {
  await cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

async function mountLocation() {
  await render(<CreateEventScreen />);
  await screen.findByText('Search for a venue, landmark, or address…');
}
async function openPicker(text = 'Canonical Sky36') {
  await fireEvent.press(screen.getByText('Search for a venue, landmark, or address…'));
  if (text) await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), text);
}
async function pickCanonical() {
  await screen.findByText('Canonical Sky36, Da Nang');
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  await waitFor(() => expect(screen.queryByPlaceholderText('City, venue or address…')).toBeNull());
}
async function saveNext() {
  await fireEvent.press(screen.getByText('Next'));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0][1].method).toBe('PATCH');
}
async function closePicker() {
  await fireEvent.press(screen.getAllByTestId('icon-X')[0]);
}
async function tick() {
  await act(async () => { jest.advanceTimersByTime(200); });
}

test.each(['close', 'unmount', 'account', 'privacy scope', 'reopen', 'active'])('triage: real recent writer must not start after invalidated selection (%s)', async boundary => {
  const pending = deferred();
  const baseFetch = fetchMock.getMockImplementation()!;
  let resolving = false;
  const recentPosts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/me/recent-places') && init?.method === 'POST');
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/me/recent-places')) {
      return { ok: true, status: 200, json: async () => ({ places: [] }) };
    }
    if (url.endsWith('/api/locations/resolve')) {
      resolving = true;
      return { ok: true, status: 200, json: () => pending.promise };
    }
    return baseFetch(url, init);
  });
  served = [];
  await mountLocation(); await openPicker('Pending manual location ' + boundary);
  await fireEvent.press(screen.getByText('Add as custom location'));
  await waitFor(() => expect(resolving).toBe(true));
  expect(recentPosts()).toHaveLength(0);
  if (boundary === 'close' || boundary === 'reopen') await closePicker();
  if (boundary === 'reopen') await openPicker('New intent');
  if (boundary === 'unmount') await cleanup();
  if (boundary === 'account') await act(async () => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); });
  if (boundary === 'privacy scope') await act(async () => { invalidateDiscoveryCaches(); });
  await act(async () => { pending.resolve({ canonicalId: 'old-' + boundary, place: {
    ...mockPlace, id: 'old-' + boundary, canonicalId: 'old-' + boundary,
    name: 'Old selected place', displayName: 'Old selected place', city: 'Old selected city',
  } }); });
  if (boundary !== 'active' && boundary !== 'unmount') {
    expect(screen.queryByText('Old selected place')).toBeNull();
    expect(screen.getByPlaceholderText('e.g. Cebu City').props.value).toBe('');
  }
  expect(writes()).toHaveLength(0);
  if (boundary === 'active') {
    await waitFor(() => expect(recentPosts()).toHaveLength(1));
    expect(JSON.parse(recentPosts()[0][1].body).place.name).toBe('Old selected place');
    expect(recentPosts()[0][1].headers.Authorization).toBe('Bearer ' + token());
  } else {
    expect(recentPosts()).toHaveLength(0);
  }
});

test('triage: same-instance close and reopen cannot revive the old pending selection', async () => {
  const pending = deferred();
  const baseFetch = fetchMock.getMockImplementation()!;
  const onSelect = jest.fn();
  const onClose = jest.fn();
  let resolving = false;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/me/recent-places')) return { ok: true, status: 200, json: async () => ({ places: [] }) };
    if (url.endsWith('/api/locations/resolve')) {
      resolving = true;
      return { ok: true, status: 200, json: () => pending.promise };
    }
    return baseFetch(url, init);
  });
  const props = { onSelect, onClose, allowGPS: false, placeholder: 'Independent picker query', usedFor: 'event_location' };
  const mounted = await render(<GlobalPlacePicker {...props} visible />);
  await fireEvent.changeText(screen.getByPlaceholderText('Independent picker query'), 'Old pending same-instance location');
  await fireEvent.press(screen.getByText('Add as custom location'));
  await waitFor(() => expect(resolving).toBe(true));
  await mounted.rerender(<GlobalPlacePicker {...props} visible={false} />);
  await mounted.rerender(<GlobalPlacePicker {...props} visible />);
  await act(async () => { pending.resolve({ place: { ...mockPlace, id: 'same-instance-old', canonicalId: 'same-instance-old' } }); });
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/me/recent-places') && init?.method === 'POST')).toHaveLength(0);
});

const recentPosts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/me/recent-places') && init?.method === 'POST');
const resolveCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/locations/resolve'));
const reverseCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/places/reverse?'));
const resolvedBody = (name: string) => ({ place: { ...mockPlace, id: name, canonicalId: name, name, displayName: name } });
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function selectionTransport(resolve: (init: RequestInit) => unknown = () => okJson({}), reverse: () => unknown = () => okJson({})) {
  const baseFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/me/recent-places')) return okJson({ places: [] });
    if (url.endsWith('/api/locations/resolve')) return resolve(init);
    if (url.includes('/api/places/reverse?')) return reverse();
    return baseFetch(url, init);
  });
}

async function directPicker(overrides: Partial<React.ComponentProps<typeof GlobalPlacePicker>> = {}) {
  const props = {
    visible: true, allowGPS: false, placeholder: 'Selection lifetime query',
    onSelect: jest.fn(), onClose: jest.fn(), onCanonicalBinding: jest.fn(), ...overrides,
  };
  const mounted = await render(<GlobalPlacePicker {...props} />);
  return { ...mounted, props };
}

async function chooseManual(name: string) {
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), name);
  await fireEvent.press(screen.getByText('Add as custom location'));
}

async function startPress(label: string) {
  const row = screen.getByText(label);
  expect(row).toBeEnabled();
  let fiber: Fiber | null = row.unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Missing mounted press handler: ' + label);
  const handler: () => Promise<void> | void = fiber.memoizedProps.onPress;
  let completion: Promise<void> | void;
  await act(async () => { completion = handler(); });
  return { finish: async () => { await completion; } };
}

function expectNoAdoption(props: React.ComponentProps<typeof GlobalPlacePicker>) {
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onCanonicalBinding).not.toHaveBeenCalled();
  expect(recentPosts()).toHaveLength(0);
}

test.each(['signout', 'roundtrip', 'same owner'])('original owner scope survives only unchanged identity: %s', async boundary => {
  const pending = deferred();
  selectionTransport(() => ({ ok: true, json: () => pending.promise }));
  const { props } = await directPicker();
  await chooseManual('Scope boundary ' + boundary);
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  await act(async () => {
    if (boundary === 'signout') mockOwner = null;
    if (boundary === 'roundtrip') setDiscoveryViewerFromSession('owner-b');
    setDiscoveryViewerFromSession(mockOwner);
    pending.resolve(resolvedBody('Scope resolved ' + boundary));
  });
  if (boundary === 'same owner') {
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(recentPosts()).toHaveLength(1));
  } else {
    expectNoAdoption(props);
    expect(props.onClose).not.toHaveBeenCalled();
  }
});

test('unknown initial identity refuses the gesture instead of binding it to later initialization', async () => {
  _resetDiscoveryViewerScopeForTests();
  selectionTransport(() => okJson(resolvedBody('Initialized selection')));
  const { props } = await directPicker({ allowGPS: true });
  await fireEvent.press(screen.getByText('Use my current location'));
  expect(ExpoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  await chooseManual('Unknown original owner');
  await act(async () => { setDiscoveryViewerFromSession('owner-a'); });
  expect(resolveCalls()).toHaveLength(0);
  expectNoAdoption(props);
  await chooseManual('New initialized intent');
  await waitFor(() => expect(props.onSelect).toHaveBeenCalledTimes(1));
  expect(resolveCalls()).toHaveLength(1);
});

test('known anonymous selection preserves raw fallback and callbacks without authenticated writes', async () => {
  mockOwner = null;
  setDiscoveryViewerFromSession(null);
  selectionTransport();
  const order: string[] = [];
  const { props } = await directPicker({
    onCanonicalBinding: jest.fn(() => { order.push('binding'); }),
    onSelect: jest.fn(() => { order.push('select'); }),
    onClose: jest.fn(() => { order.push('close'); }),
  });
  await chooseManual('Anonymous chosen city');
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Anonymous chosen city', source: 'manual' }));
  expect(order).toEqual(['binding', 'select', 'close']);
  expect(resolveCalls()).toHaveLength(0);
  expect(recentPosts()).toHaveLength(0);
});

test.each(['reopen', 'owner'])('old finally cannot unlock the successor selection after %s', async boundary => {
  const old = deferred();
  const next = deferred();
  selectionTransport(init => ({ ok: true, json: () => JSON.parse(String(init.body)).place.name.startsWith('Old') ? old.promise : next.promise }));
  const { props, rerender } = await directPicker();
  await chooseManual('Old finalizer ' + boundary);
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  if (boundary === 'reopen') {
    await rerender(<GlobalPlacePicker {...props} visible={false} />);
    await rerender(<GlobalPlacePicker {...props} />);
  } else {
    await act(async () => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); });
  }
  await chooseManual('New finalizer ' + boundary);
  await waitFor(() => expect(resolveCalls()).toHaveLength(2));
  await act(async () => { old.resolve(resolvedBody('Discarded finalizer ' + boundary)); });
  expect(screen.getByText('Add as custom location')).toBeDisabled();
  await fireEvent.press(screen.getByText('Add as custom location'));
  expect(resolveCalls()).toHaveLength(2);
  expectNoAdoption(props);
  await act(async () => { next.resolve(resolvedBody('Current finalizer ' + boundary)); });
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Current finalizer ' + boundary }));
  await waitFor(() => expect(recentPosts()).toHaveLength(1));
  expect(recentPosts()[0][1].headers.Authorization).toBe('Bearer ' + token());
});

test('same-turn submit gestures serialize before state renders', async () => {
  const pending = deferred();
  selectionTransport(() => ({ ok: true, json: () => pending.promise }));
  const { props } = await directPicker();
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Synchronous double submit');
  const submit = screen.getByPlaceholderText('Selection lifetime query').props.onSubmitEditing;
  await act(async () => { submit(); submit(); });
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  await act(async () => { pending.resolve(resolvedBody('Only selection')); });
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(recentPosts()).toHaveLength(1));
});

test.each(['close', 'account', 'active', 'no details'])('Google details retain original gesture ownership: %s', async boundary => {
  const pending = deferred();
  mockGooglePlaces = [{ ...mockPlace, type: 'place', region: null, district: null, source: 'google', canonicalId: null, id: 'google-stage-' + boundary }];
  jest.mocked(fetchGooglePlaceDetails).mockImplementation(() => pending.promise as ReturnType<typeof fetchGooglePlaceDetails>);
  selectionTransport(() => okJson(resolvedBody('Google resolved ' + boundary)));
  const { props } = await directPicker();
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Google stage');
  const press = await startPress('Legacy Venue');
  expect(fetchGooglePlaceDetails).toHaveBeenCalledTimes(1);
  if (boundary === 'close') await closePicker();
  if (boundary === 'account') await act(async () => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); });
  await act(async () => { pending.resolve(boundary === 'no details' ? null : { lat: 1, lng: 2, formattedAddress: 'Enriched address' }); });
  await press.finish();
  if (boundary === 'active' || boundary === 'no details') {
    expect(resolveCalls()).toHaveLength(1);
    const sent = JSON.parse(resolveCalls()[0][1].body).place;
    expect(sent.lat).toBe(boundary === 'active' ? 1 : mockPlace.lat);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  } else {
    expect(resolveCalls()).toHaveLength(0);
    expectNoAdoption(props);
    expect(props.onClose).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0);
  }
});

test.each(['response', 'json'])('canonical %s completion after dismissal cannot start downstream effects', async stage => {
  const pending = deferred();
  selectionTransport(() => stage === 'response' ? pending.promise : { ok: true, json: () => pending.promise });
  const { props } = await directPicker();
  await chooseManual('Resolver held ' + stage);
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  await closePicker();
  await act(async () => { pending.resolve(stage === 'response' ? okJson(resolvedBody('Old response')) : resolvedBody('Old JSON')); });
  expectNoAdoption(props);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test.each(['http', 'throw', 'malformed'])('active resolution %s failure preserves manual fallback exactly once', async failure => {
  selectionTransport(() => {
    if (failure === 'throw') throw new Error('Local simulated offline');
    return failure === 'http' ? { ok: false, status: 503 } : okJson({ place: null });
  });
  const { props } = await directPicker();
  await chooseManual('Fallback ' + failure);
  await waitFor(() => expect(props.onSelect).toHaveBeenCalledTimes(1));
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Fallback ' + failure, source: 'manual' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(recentPosts()).toHaveLength(1));
});

function nativeFix() {
  const pending = deferred();
  jest.mocked(ExpoLocation.requestForegroundPermissionsAsync).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' } as ExpoLocation.LocationPermissionResponse);
  jest.mocked(ExpoLocation.getCurrentPositionAsync).mockImplementation(() => pending.promise as Promise<ExpoLocation.LocationObject>);
  return pending;
}

const fix = { coords: { latitude: 10, longitude: 20, accuracy: 5 }, timestamp: 1 };

test.each(['close', 'unmount', 'account', 'reopen', 'manual', 'active'])('GPS native wait carries the original gesture: %s', async boundary => {
  const pending = nativeFix();
  selectionTransport(() => okJson(resolvedBody('Current GPS ' + boundary)), () => okJson({ place: { ...mockPlace, id: 'gps-result-' + boundary, canonicalId: null } }));
  const { props, rerender } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  await waitFor(() => expect(ExpoLocation.getCurrentPositionAsync).toHaveBeenCalledTimes(1));
  if (boundary === 'close') await closePicker();
  if (boundary === 'unmount') await cleanup();
  if (boundary === 'account') await act(async () => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); });
  if (boundary === 'reopen') {
    await rerender(<GlobalPlacePicker {...props} visible={false} />);
    await rerender(<GlobalPlacePicker {...props} />);
  }
  if (boundary === 'manual') await chooseManual('GPS replacement manual');
  await act(async () => { pending.resolve(fix); });
  await press.finish();
  if (boundary === 'active' || boundary === 'manual') {
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(reverseCalls()).toHaveLength(boundary === 'active' ? 1 : 0);
    expect(resolveCalls()).toHaveLength(1);
  } else {
    expect(reverseCalls()).toHaveLength(0);
    expect(resolveCalls()).toHaveLength(0);
    expectNoAdoption(props);
  }
});

test.each(['response', 'json', 'fallback error'])('GPS reverse %s cannot recapture a new owner', async stage => {
  const pending = deferred();
  const gps = nativeFix();
  selectionTransport(() => okJson(resolvedBody('Should not resolve')), () => stage === 'response' ? pending.promise : {
    ok: true, json: async () => {
      const result = await pending.promise;
      if (stage === 'fallback error') throw new Error('Local delayed body failure');
      return result;
    },
  });
  const { props } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  await act(async () => { gps.resolve(fix); });
  await waitFor(() => expect(reverseCalls()).toHaveLength(1));
  await act(async () => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); });
  await act(async () => { pending.resolve(stage === 'response' ? okJson(resolvedBody('Old reverse')) : resolvedBody('Old reverse')); });
  await press.finish();
  expect(resolveCalls()).toHaveLength(0);
  expectNoAdoption(props);
  expect(screen.queryByText("Couldn't get location. Choose a city below.")).toBeNull();
});

test.each(['http', 'throw', 'empty'])('healthy GPS reverse %s fallback still selects raw coordinates', async boundary => {
  const gps = nativeFix();
  selectionTransport(() => ({ ok: false, status: 503 }), () => {
    if (boundary === 'throw') throw new Error('Local reverse offline');
    return boundary === 'http' ? { ok: false, status: 503 } : okJson({});
  });
  const { props } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  await act(async () => { gps.resolve(fix); });
  await press.finish();
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ source: 'gps', lat: 10, lng: 20, name: 'Current Location' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test.each(['denied', 'error'])('healthy explicit GPS %s retains its existing message', async result => {
  jest.mocked(ExpoLocation.requestForegroundPermissionsAsync).mockImplementation(async () => {
    if (result === 'error') throw new Error('Local native error');
    return { status: 'denied', granted: false, canAskAgain: true, expires: 'never' } as ExpoLocation.LocationPermissionResponse;
  });
  selectionTransport();
  const { props } = await directPicker({ allowGPS: true });
  await fireEvent.press(screen.getByText('Use my current location'));
  expect(screen.getByText(result === 'denied' ? 'Location is off. Choose a city manually.' : "Couldn't get location. Choose a city below.")).toBeTruthy();
  expect(screen.getByText('Use my current location')).toBeEnabled();
  expectNoAdoption(props);
});

test('late native refusal cannot paint an error in a reopened sheet', async () => {
  const pending = deferred();
  jest.mocked(ExpoLocation.requestForegroundPermissionsAsync).mockImplementation(() => pending.promise as Promise<ExpoLocation.LocationPermissionResponse>);
  selectionTransport();
  const { props, rerender } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  await rerender(<GlobalPlacePicker {...props} visible={false} />);
  await rerender(<GlobalPlacePicker {...props} />);
  await act(async () => { pending.resolve({ status: 'denied' }); });
  await press.finish();
  expect(screen.queryByText('Location is off. Choose a city manually.')).toBeNull();
  expect(screen.getByText('Use my current location')).toBeEnabled();
  expectNoAdoption(props);
});

test.each(['active', 'binding invalidation', 'select invalidation'])('canonical gateway callback chain: %s', async boundary => {
  selectionTransport();
  const record = jest.spyOn(selectionRecorder, 'recordSuggestionSelection');
  const warm = jest.spyOn(prefetch, 'prefetchDependentFields');
  const order: string[] = [];
  const { props } = await directPicker({
    assistContext: 'event_location', assistFieldId: 'event_location',
    onCanonicalBinding: jest.fn(() => { order.push('binding'); if (boundary === 'binding invalidation') invalidateDiscoveryCaches(); }),
    onSelect: jest.fn(() => { order.push('select'); if (boundary === 'select invalidation') invalidateDiscoveryCaches(); }),
    onClose: jest.fn(() => { order.push('close'); }),
  });
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Canonical Sky36');
  await tick();
  await screen.findByText('Canonical Sky36, Da Nang');
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  expect(order).toEqual(boundary === 'active' ? ['binding', 'select', 'close'] : boundary === 'binding invalidation' ? ['binding'] : ['binding', 'select']);
  expect(record).toHaveBeenCalledTimes(boundary === 'binding invalidation' ? 0 : 1);
  expect(warm).toHaveBeenCalledTimes(boundary === 'binding invalidation' ? 0 : 1);
  await tick();
  expect(recentPosts()).toHaveLength(boundary === 'active' ? 1 : 0);
  expect(props.onClose).toHaveBeenCalledTimes(boundary === 'active' ? 1 : 0);
});

test('silent permission completion from a previous open cannot start a last-known lookup', async () => {
  const pending = deferred();
  jest.mocked(ExpoLocation.getForegroundPermissionsAsync).mockImplementationOnce(() => pending.promise as Promise<ExpoLocation.LocationPermissionResponse>);
  selectionTransport();
  const { props, rerender } = await directPicker();
  await rerender(<GlobalPlacePicker {...props} visible={false} />);
  await rerender(<GlobalPlacePicker {...props} />);
  await act(async () => { pending.resolve({ granted: true }); });
  expect(ExpoLocation.getLastKnownPositionAsync).not.toHaveBeenCalled();
  expect(reverseCalls()).toHaveLength(0);
});

test('superseded GPS completion cannot unlock an unresolved manual replacement', async () => {
  const gps = nativeFix();
  const manual = deferred();
  selectionTransport(() => ({ ok: true, json: () => manual.promise }));
  const { props } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  await chooseManual('Manual still resolving');
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  await act(async () => { gps.resolve(fix); });
  await press.finish();
  expect(screen.getByText('Add as custom location')).toBeDisabled();
  expect(reverseCalls()).toHaveLength(0);
  expectNoAdoption(props);
  await act(async () => { manual.resolve(resolvedBody('Manual replacement won')); });
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Manual replacement won' }));
});

test.each(['position', 'response', 'json'])('silent nearby %s from an obsolete open cannot populate its successor', async stage => {
  const pending = deferred();
  jest.mocked(ExpoLocation.getForegroundPermissionsAsync).mockResolvedValueOnce({ granted: true } as ExpoLocation.LocationPermissionResponse);
  jest.mocked(ExpoLocation.getLastKnownPositionAsync).mockImplementationOnce(() => (
    stage === 'position' ? pending.promise : Promise.resolve(fix)
  ) as Promise<ExpoLocation.LocationObject>);
  const readBody = jest.fn(() => stage === 'json' ? pending.promise : Promise.resolve(resolvedBody('Old silent city')));
  selectionTransport(undefined, () => stage === 'response' ? pending.promise : { ok: true, json: readBody });
  const { props, rerender } = await directPicker();
  await waitFor(() => expect(ExpoLocation.getLastKnownPositionAsync).toHaveBeenCalledTimes(1));
  if (stage !== 'position') await waitFor(() => expect(reverseCalls()).toHaveLength(1));
  await rerender(<GlobalPlacePicker {...props} visible={false} />);
  await rerender(<GlobalPlacePicker {...props} />);
  await act(async () => { pending.resolve(stage === 'position' ? fix : stage === 'response' ? { ok: true, json: readBody } : resolvedBody('Old silent city')); });
  expect(screen.queryByText('Old silent city')).toBeNull();
  expect(reverseCalls()).toHaveLength(stage === 'position' ? 0 : 1);
  expect(readBody).toHaveBeenCalledTimes(stage === 'json' ? 1 : 0);
});

test('GPS consumer failure does not repeat binding, recent write or selection as a coordinate fallback', async () => {
  const gps = nativeFix();
  selectionTransport(() => okJson(resolvedBody('Unexpected fallback')), () => okJson(resolvedBody('Canonical GPS')));
  const { props } = await directPicker({
    allowGPS: true,
    onSelect: jest.fn(() => { throw new Error('Consumer rejected the chosen place'); }),
  });
  const press = await startPress('Use my current location');
  await act(async () => { gps.resolve(fix); });
  await press.finish();
  await tick();
  expect({
    selections: jest.mocked(props.onSelect).mock.calls.length,
    bindings: jest.mocked(props.onCanonicalBinding).mock.calls.length,
    writes: recentPosts().length,
    fallbacks: resolveCalls().length,
  }).toEqual({ selections: 1, bindings: 1, writes: 1, fallbacks: 0 });
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Canonical GPS' }));
  expect(props.onClose).not.toHaveBeenCalled();
});

function mountedCloseHandler(): () => void {
  let fiber: Fiber | null = screen.getAllByTestId('icon-X')[0].unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Missing mounted close handler');
  return fiber.memoizedProps.onPress;
}

test.each(['pin', 'add'])('zero-action %s does not continue after close changes the owner', async action => {
  holdRequest = async () => answer([{
    id: 'zero-' + action, context: 'event_location', type: 'action', source: 'system',
    label: action === 'pin' ? 'Drop a pin' : 'Add a new place',
    action: action === 'pin' ? { type: 'drop_pin' } : { type: 'set_structured_value', value: { kind: 'create_entity' } },
  }]);
  selectionTransport();
  const onAction = jest.fn();
  const { props } = await directPicker({
    assistContext: 'event_location', onDropPin: onAction, onAddNew: onAction,
    onClose: jest.fn(() => { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); }),
  });
  await screen.findByTestId('place-zero-' + action);
  await fireEvent.press(screen.getByTestId('place-zero-' + action));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(onAction).not.toHaveBeenCalled();
  expectNoAdoption(props);
});

test('approximate-area callback cannot dismiss the next owner after reentrant account change', async () => {
  served = [{
    id: 'area', context: 'event_location', type: 'action', source: 'system', label: 'Use approximate area',
    structuredValue: { kind: 'approximate_area', cityId: 'area-city', city: 'City', country: null, timezone: null },
  }];
  selectionTransport();
  const order: string[] = [];
  const { props } = await directPicker({
    assistContext: 'event_location',
    onApproximateArea: jest.fn(() => { order.push('area'); mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); }),
    onClose: jest.fn(() => { order.push('close'); }),
  });
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Area city');
  await tick();
  await screen.findByTestId('place-area-area-city');
  await fireEvent.press(screen.getByTestId('place-area-area-city'));
  expect(props.onApproximateArea).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['area']);
  expectNoAdoption(props);
});

test.each(['active', 'privacy', 'reentrant close'])('alternate callbacks preserve only their own dismissal: %s', async boundary => {
  holdRequest = async () => answer([{
    id: 'drop', context: 'event_location', type: 'action', source: 'system', label: 'Drop a pin', action: { type: 'drop_pin' },
  }]);
  selectionTransport();
  const order: string[] = [];
  let close: () => void = () => { throw new Error('Close not captured'); };
  const { props } = await directPicker({
    assistContext: 'event_location',
    onDropPin: jest.fn(() => { order.push('pin'); }),
    onClose: jest.fn(() => {
      order.push('close');
      if (boundary === 'privacy') invalidateDiscoveryCaches();
      if (boundary === 'reentrant close' && order.length === 1) close();
    }),
  });
  close = mountedCloseHandler();
  await screen.findByTestId('place-zero-pin');
  await fireEvent.press(screen.getByTestId('place-zero-pin'));
  expect(order).toEqual(boundary === 'privacy' ? ['close'] : boundary === 'reentrant close' ? ['close', 'close'] : ['close', 'pin']);
  expectNoAdoption(props);
});

test.each(['active', 'privacy', 'reentrant close'])('approximate-area callbacks preserve original open: %s', async boundary => {
  const area = { kind: 'approximate_area', cityId: 'area-city', city: 'City', country: null, timezone: null };
  served = [{ id: 'area', context: 'event_location', type: 'action', source: 'system', label: 'Use approximate area', structuredValue: area }];
  selectionTransport();
  const order: string[] = [];
  let close: () => void = () => { throw new Error('Close not captured'); };
  const { props } = await directPicker({
    assistContext: 'event_location',
    onApproximateArea: jest.fn(() => {
      order.push('area');
      if (boundary === 'privacy') invalidateDiscoveryCaches();
      if (boundary === 'reentrant close') close();
    }),
    onClose: jest.fn(() => { order.push('close'); }),
  });
  close = mountedCloseHandler();
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Area city');
  await tick();
  await screen.findByTestId('place-area-area-city');
  await fireEvent.press(screen.getByTestId('place-area-area-city'));
  expect(order).toEqual(boundary === 'privacy' ? ['area'] : ['area', 'close']);
  expect(props.onApproximateArea).toHaveBeenCalledTimes(1);
  expect(props.onApproximateArea).toHaveBeenCalledWith({ cityId: 'area-city', city: 'City', country: null, countryCode: null, timezone: null });
  expectNoAdoption(props);
});

test.each(['pin', 'add'])('healthy %s action survives its own parent-driven dismissal', async action => {
  holdRequest = async () => answer([{
    id: 'zero-' + action, context: 'event_location', type: 'action', source: 'system',
    label: action === 'pin' ? 'Drop a pin' : 'Add a new place',
    action: action === 'pin' ? { type: 'drop_pin' } : { type: 'set_structured_value', value: { kind: 'create_entity' } },
  }]);
  selectionTransport();
  const order: string[] = [];
  const onAction = jest.fn(() => { order.push(action); });
  const onSelect = jest.fn();
  function Host() {
    const [visible, setVisible] = React.useState(true);
    return <GlobalPlacePicker visible={visible} allowGPS={false} assistContext="event_location"
      onSelect={onSelect} onDropPin={onAction} onAddNew={onAction}
      onClose={() => { order.push('close'); setVisible(false); }} />;
  }
  await render(<Host />);
  await screen.findByTestId('place-zero-' + action);
  await fireEvent.press(screen.getByTestId('place-zero-' + action));
  expect(order).toEqual(['close', action]);
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByTestId('place-zero-' + action)).toBeNull();
  expect(recentPosts()).toHaveLength(0);
});

function changePickerSession(boundary: 'replacement' | 'refresh') {
  if (boundary === 'replacement') {
    mockSessionGeneration += 1;
    setDiscoveryViewerFromSession(mockOwner);
    return;
  }
  const current = mockSession()!;
  const refreshed = { ...current, access_token: `header.${btoa(JSON.stringify({ sub: mockOwner, session_id: `picker-session-${mockOwner}-${mockSessionGeneration}`, version: 'refreshed' }))}.signature` };
  for (const listener of mockAuthListeners ?? []) listener('TOKEN_REFRESHED', refreshed);
}

test.each(['replacement', 'refresh'] as const)('Google details preserve the original session and release their own retired slot: %s', async boundary => {
  const pending = deferred();
  mockGooglePlaces = [{ ...mockPlace, type: 'place', region: null, district: null, source: 'google', canonicalId: null, id: 'google-session-' + boundary }];
  jest.mocked(fetchGooglePlaceDetails).mockImplementation(() => pending.promise as ReturnType<typeof fetchGooglePlaceDetails>);
  selectionTransport(() => okJson(resolvedBody('Fresh Google session ' + boundary)));
  const { props } = await directPicker();
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Google session query');
  const press = await startPress('Legacy Venue');
  const listeners = mockAuthListeners!.size;
  await act(async () => { changePickerSession(boundary); pending.resolve({ lat: 0, lng: 0, formattedAddress: 'Zero coordinate address' }); });
  await press.finish();
  await tick();
  if (boundary === 'replacement') {
    expectNoAdoption(props);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(0);
    expect(screen.getByText('Legacy Venue')).toBeEnabled();
    await fireEvent.press(screen.getByText('Legacy Venue'));
    await tick();
    expect(fetchGooglePlaceDetails).toHaveBeenCalledTimes(2);
  } else expect(fetchGooglePlaceDetails).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(resolveCalls()).toHaveLength(1);
  expect(recentPosts()).toHaveLength(1);
  expect(mockAuthListeners!.size).toBe(listeners);
});

const sessionGpsStages = (['permission', 'position', 'reverse-response', 'reverse-json', 'reverse-error'] as const)
  .flatMap(stage => (['replacement', 'refresh'] as const).map(boundary => [stage, boundary] as const));

test.each(sessionGpsStages)('GPS %s under %s retains only its original session and owned busy state', async (stage, boundary) => {
  const pending = deferred();
  const permission = { status: 'granted', granted: true, canAskAgain: true, expires: 'never' } as ExpoLocation.LocationPermissionResponse;
  jest.mocked(ExpoLocation.requestForegroundPermissionsAsync).mockImplementation(() => (
    stage === 'permission' ? pending.promise : Promise.resolve(permission)
  ) as Promise<ExpoLocation.LocationPermissionResponse>);
  jest.mocked(ExpoLocation.getCurrentPositionAsync).mockImplementation(() => (
    stage === 'position' ? pending.promise : Promise.resolve(fix)
  ) as Promise<ExpoLocation.LocationObject>);
  const reverse = { place: { ...mockPlace, id: 'gps-session-' + stage, canonicalId: null } };
  selectionTransport(() => okJson(resolvedBody('Fresh GPS session ' + stage)), () => {
    if (stage === 'reverse-response') return pending.promise;
    if (stage === 'reverse-json' || stage === 'reverse-error') return { ok: true, json: async () => {
      const result = await pending.promise;
      if (stage === 'reverse-error') throw new Error('Synthetic reverse failure');
      return result;
    } };
    return okJson(reverse);
  });
  const { props } = await directPicker({ allowGPS: true });
  const press = await startPress('Use my current location');
  if (stage.startsWith('reverse')) await waitFor(() => expect(reverseCalls()).toHaveLength(1));
  else if (stage === 'position') await waitFor(() => expect(ExpoLocation.getCurrentPositionAsync).toHaveBeenCalledTimes(1));
  else expect(ExpoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  const listeners = mockAuthListeners!.size;
  await act(async () => {
    changePickerSession(boundary);
    pending.resolve(stage === 'permission' ? permission : stage === 'position' ? fix : stage === 'reverse-response' ? okJson(reverse) : reverse);
  });
  await press.finish();
  await tick();
  if (boundary === 'replacement') {
    expectNoAdoption(props);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(0);
    expect(reverseCalls()).toHaveLength(stage.startsWith('reverse') ? 1 : 0);
    expect(screen.getByText('Use my current location')).toBeEnabled();
    expect(screen.queryByText("Couldn't get location. Choose a city below.")).toBeNull();
    await fireEvent.press(screen.getByText('Use my current location'));
    await tick();
  }
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(resolveCalls()).toHaveLength(1);
  expect(recentPosts()).toHaveLength(1);
  expect(mockAuthListeners!.size).toBe(listeners);
});

test.each(['reopen', 'manual'] as const)('retired GPS finally cannot release a newer pending selection after %s', async boundary => {
  const gps = nativeFix();
  const next = deferred();
  selectionTransport(() => ({ ok: true, json: () => next.promise }));
  const { props, rerender } = await directPicker({ allowGPS: true });
  const old = await startPress('Use my current location');
  await act(async () => { changePickerSession('replacement'); });
  if (boundary === 'reopen') {
    await rerender(<GlobalPlacePicker {...props} visible={false} />);
    await rerender(<GlobalPlacePicker {...props} />);
  }
  await chooseManual('New session selection still pending ' + boundary);
  await waitFor(() => expect(resolveCalls()).toHaveLength(1));
  await act(async () => { gps.resolve(fix); });
  await old.finish();
  expect(screen.getByText('Add as custom location')).toBeDisabled();
  await fireEvent.press(screen.getByText('Add as custom location'));
  expect(resolveCalls()).toHaveLength(1);
  expect(reverseCalls()).toHaveLength(0);
  expectNoAdoption(props);
  await act(async () => { next.resolve(resolvedBody('New session owns finalizer ' + boundary)); });
  await tick();
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'New session owns finalizer ' + boundary }));
  expect(recentPosts()).toHaveLength(1);
});

test.each((['pin', 'add'] as const).flatMap(action => (['replacement', 'refresh'] as const).map(boundary => [action, boundary] as const)))('zero action %s survives only a current session after its own close: %s', async (action, boundary) => {
  holdRequest = async () => answer([{
    id: 'session-zero-' + action, context: 'event_location', type: 'action', source: 'system',
    label: action === 'pin' ? 'Drop a pin' : 'Add a new place',
    action: action === 'pin' ? { type: 'drop_pin' } : { type: 'set_structured_value', value: { kind: 'create_entity' } },
  }]);
  selectionTransport();
  const onAction = jest.fn();
  const { props } = await directPicker({ assistContext: 'event_location', onDropPin: onAction, onAddNew: onAction,
    onClose: jest.fn(() => { changePickerSession(boundary); }),
  });
  await screen.findByTestId('place-zero-' + action);
  await fireEvent.press(screen.getByTestId('place-zero-' + action));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(onAction).toHaveBeenCalledTimes(boundary === 'replacement' ? 0 : 1);
  expectNoAdoption(props);
});

test.each(['replacement', 'refresh'] as const)('approximate-area callback retains the original dismissal session: %s', async boundary => {
  served = [{ id: 'session-area', context: 'event_location', type: 'action', source: 'system', label: 'Use approximate area',
    structuredValue: { kind: 'approximate_area', cityId: 'session-area-city', city: 'City', country: null, timezone: null } }];
  selectionTransport();
  const { props } = await directPicker({ assistContext: 'event_location',
    onApproximateArea: jest.fn(() => { changePickerSession(boundary); }),
  });
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Session area city');
  await tick();
  await screen.findByTestId('place-area-session-area-city');
  await fireEvent.press(screen.getByTestId('place-area-session-area-city'));
  expect(props.onApproximateArea).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(boundary === 'replacement' ? 0 : 1);
  expectNoAdoption(props);
});

test.each(['binding', 'select'] as const)('gateway %s callback session replacement stops remaining same-owner effects', async stage => {
  selectionTransport();
  const record = jest.spyOn(selectionRecorder, 'recordSuggestionSelection');
  const warm = jest.spyOn(prefetch, 'prefetchDependentFields');
  const { props } = await directPicker({ assistContext: 'event_location', assistFieldId: 'event_location',
    onCanonicalBinding: jest.fn(() => { if (stage === 'binding') changePickerSession('replacement'); }),
    onSelect: jest.fn(() => { if (stage === 'select') changePickerSession('replacement'); }),
  });
  await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Canonical Sky36');
  await tick();
  await screen.findByText('Canonical Sky36, Da Nang');
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  await tick();
  expect(props.onCanonicalBinding).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledTimes(stage === 'binding' ? 0 : 1);
  expect(record).toHaveBeenCalledTimes(stage === 'binding' ? 0 : 1);
  expect(warm).toHaveBeenCalledTimes(stage === 'binding' ? 0 : 1);
  expect(recentPosts()).toHaveLength(0);
  expect(props.onClose).not.toHaveBeenCalled();
});

// D3 — the early refusal in beginSelection (`if (scope.viewer !== ANONYMOUS_VIEWER && !owner) return null;`).
// A signed-in Discovery viewer whose OBSERVED auth session yields no matching owner identity must not
// reach the approximate-area or zero-action callbacks, and the refusal happens before any dismissal.
// Appended (with its imports) so every test above stays a byte-identical prefix.
import { captureMessagingOwnerRequest, disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../../services/messagingOwnerRequest.ts';
import { currentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';

const missingOwnerIdentities = ['unobserved', 'signed out', 'malformed session', 'other owner'] as const;
function dropObservedOwnerIdentity(identity: typeof missingOwnerIdentities[number]) {
  if (identity === 'unobserved') {
    // A fresh observer the SDK has not yet notified: clearing the recorded listeners keeps the
    // stub's deferred INITIAL_SESSION from ever reaching it.
    disposeMessagingOwnerObserver();
    initializeMessagingOwnerObserver();
    mockAuthListeners?.clear();
    return;
  }
  const session = identity === 'signed out' ? null
    : identity === 'other owner' ? mockSession('owner-b')
    : { ...mockSession('owner-a')!, access_token: `header.${btoa(JSON.stringify({ sub: 'owner-a' }))}.signature` };
  for (const listener of [...(mockAuthListeners ?? [])]) listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
}

test.each(missingOwnerIdentities.flatMap(identity => (['area', 'pin', 'add'] as const).map(row => [row, identity] as const)))('signed-in viewer without an owner identity: %s row refuses before any callback or dismissal (%s)', async (row, identity) => {
  if (row === 'area') {
    served = [{ id: 'missing-owner-area', context: 'event_location', type: 'action', source: 'system', label: 'Use approximate area',
      structuredValue: { kind: 'approximate_area', cityId: 'missing-owner-city', city: 'City', country: null, timezone: null } }];
  } else {
    holdRequest = async () => answer([{
      id: 'missing-owner-' + row, context: 'event_location', type: 'action', source: 'system',
      label: row === 'pin' ? 'Drop a pin' : 'Add a new place',
      action: row === 'pin' ? { type: 'drop_pin' } : { type: 'set_structured_value', value: { kind: 'create_entity' } },
    }]);
  }
  selectionTransport();
  const { props } = await directPicker({ assistContext: 'event_location',
    onApproximateArea: jest.fn(), onDropPin: jest.fn(), onAddNew: jest.fn() });
  const testId = row === 'area' ? 'place-area-missing-owner-city' : 'place-zero-' + row;
  if (row === 'area') {
    await fireEvent.changeText(screen.getByPlaceholderText('Selection lifetime query'), 'Missing owner city');
    await tick();
  }
  await screen.findByTestId(testId);
  try {
    await act(async () => { dropObservedOwnerIdentity(identity); });
    // Precondition: still a named (signed-in) viewer, but no owner request can be captured for it.
    expect(currentDiscoveryScope().viewer).toBe('u:owner-a');
    expect(captureMessagingOwnerRequest()).toBeNull();
    await fireEvent.press(screen.getByTestId(testId));
    await tick();
    expect(props.onApproximateArea).not.toHaveBeenCalled();
    expect(props.onDropPin).not.toHaveBeenCalled();
    expect(props.onAddNew).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expectNoAdoption(props);
    // The sheet was not dismissed: the refused row is still on screen.
    expect(screen.getByTestId(testId)).toBeTruthy();
  } finally {
    // Re-seat a live observer so later tests' beforeEach SIGNED_IN reaches it.
    disposeMessagingOwnerObserver();
    initializeMessagingOwnerObserver();
  }
});
